/*
 * 廣編採訪排程 — 核心邏輯（網頁、LINE 推播 Worker、日報共用同一份）
 * 一律以台灣時區（Asia/Taipei）判斷「今天」，Worker 跑在 UTC 也不會差一天。
 * 日期格式固定 'YYYY-MM-DD'，時間 'HH:MM'。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrewCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TZ = 'Asia/Taipei';
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const LEVEL_ORDER = { overdue: 0, today: 1, soon: 2, week: 3, later: 4 };

  // ── 日期工具 ───────────────────────────────────────────────
  function todayTW(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
  }
  function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function isTime(s) { return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s); }
  function dayNum(s) {
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  function diffDays(from, to) { return dayNum(to) - dayNum(from); }
  function addDays(s, n) { return new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10); }
  function weekday(s) { return WEEK[new Date(dayNum(s) * 86400000).getUTCDay()]; }
  function fmtDate(s) {
    if (!isDate(s)) return '';
    const [, m, d] = s.split('-').map(Number);
    return `${m}/${d}（${weekday(s)}）`;
  }
  function level(diff) {
    if (diff < 0) return 'overdue';
    if (diff === 0) return 'today';
    if (diff <= 3) return 'soon';
    if (diff <= 7) return 'week';
    return 'later';
  }

  // ── 資料正規化 ─────────────────────────────────────────────
  // Firebase 會把陣列存成 {0:…,1:…}，讀回來可能是物件，這裡統一轉成陣列
  function crewOf(job) {
    if (!job || !job.crew) return [];
    const list = Array.isArray(job.crew) ? job.crew : Object.values(job.crew);
    return list.filter(Boolean);
  }
  function feeOf(c) {
    const n = Number(c && c.fee);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  // 免採訪的案子（noInterview）沒有採訪日，一律忽略殘留的 interviewDate
  function interviewOf(job) {
    return !job.noInterview && isDate(job.interviewDate) ? job.interviewDate : '';
  }
  // 案子的代表日期：有採訪看採訪日；免採訪看最早的交稿日（稿費歸月、卡片日期方塊都用這個）
  function anchorDate(job) {
    if (!job) return '';
    if (!job.noInterview) return interviewOf(job);
    return crewOf(job).map(c => c.dueDate).filter(isDate).sort()[0] || '';
  }

  // ── 單一案子狀態 ───────────────────────────────────────────
  // 採訪日已過＝採訪完成；交稿以「已交」勾選為準
  function jobStatus(job, today) {
    const crew = crewOf(job);
    const pending = [];
    const iv = interviewOf(job);
    if (iv && diffDays(today, iv) >= 0) {
      pending.push({ kind: 'interview', date: iv, time: job.interviewTime || '' });
    }
    crew.forEach((c, i) => {
      if (!c.delivered && isDate(c.dueDate)) {
        pending.push({ kind: 'due', date: c.dueDate, time: '', crewIndex: i });
      }
    });
    const missingDue = crew.some(c => !c.delivered && !isDate(c.dueDate));
    const overdue = pending.filter(e => e.kind === 'due' && diffDays(today, e.date) < 0).length;

    if (!pending.length) {
      const hasAnyDate = !!iv || crew.some(c => isDate(c.dueDate));
      if (missingDue || !hasAnyDate) return { group: 'nodate', nextDate: '', next: null, overdue: 0, missingDue };
      return { group: 'done', nextDate: '', next: null, overdue: 0, missingDue: false };
    }
    pending.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    const next = pending[0];
    return { group: level(diffDays(today, next.date)), nextDate: next.date, next, overdue, missingDue };
  }

  // ── 今日提醒清單（網頁頂部、LINE、日報共用）─────────────────
  // 採訪：今天、明天；交稿：逾期、今天、2 天內
  function reminderItems(entries, today) {
    const items = [];
    entries.forEach(([id, job]) => {
      if (!job) return;
      const base = { jobId: id, client: job.client || '', topic: job.topic || '' };
      if (interviewOf(job)) {
        const d = diffDays(today, job.interviewDate);
        if (d === 0 || d === 1) {
          items.push({
            ...base, kind: 'interview', diff: d, level: d === 0 ? 'today' : 'soon',
            date: job.interviewDate, time: job.interviewTime || '',
            location: job.location || '', interviewee: job.interviewee || '',
            label: d === 0 ? '今天採訪' : '明天採訪',
            crew: crewOf(job).map(c => ({ name: c.name || '', role: c.role || '' }))
          });
        }
      }
      crewOf(job).forEach((c, i) => {
        if (c.delivered || !isDate(c.dueDate)) return;
        const d = diffDays(today, c.dueDate);
        if (d > 2) return;
        items.push({
          ...base, kind: 'due', diff: d, level: d < 0 ? 'overdue' : d === 0 ? 'today' : 'soon',
          date: c.dueDate, time: '', crewIndex: i, name: c.name || '', role: c.role || '',
          label: d < 0 ? `逾期 ${-d} 天` : d === 0 ? '今天交稿' : `${d} 天後交稿`
        });
      });
    });
    return items.sort((a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      a.date.localeCompare(b.date) ||
      (a.kind === 'interview' ? 0 : 1) - (b.kind === 'interview' ? 0 : 1) ||
      a.time.localeCompare(b.time));
  }

  // ── 稿費：依採訪日歸月 ─────────────────────────────────────
  function monthlyFees(entries) {
    const months = {};
    entries.forEach(([id, job]) => {
      if (!job) return;
      const anchor = anchorDate(job);
      const key = anchor ? anchor.slice(0, 7) : 'none';
      const m = months[key] || (months[key] = { month: key, total: 0, jobs: [], people: {} });
      const crew = crewOf(job);
      const jobTotal = crew.reduce((s, c) => s + feeOf(c), 0);
      m.total += jobTotal;
      m.jobs.push({ id, job, total: jobTotal });
      crew.forEach(c => {
        const k = c.personId || `name:${c.name || ''}`;
        const p = m.people[k] || (m.people[k] = { key: k, personId: c.personId || '', name: c.name || '', role: c.role || '', count: 0, total: 0 });
        p.count += 1;
        p.total += feeOf(c);
      });
    });
    return Object.values(months)
      .map(m => ({
        ...m,
        jobs: m.jobs.sort((a, b) => anchorDate(a.job).localeCompare(anchorDate(b.job))),
        people: Object.values(m.people).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      }))
      .sort((a, b) => (a.month === 'none') - (b.month === 'none') || b.month.localeCompare(a.month));
  }

  // ── 行事曆 .ics ───────────────────────────────────────────
  function icsEscape(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function utf8len(ch) {
    const cp = ch.codePointAt(0);
    return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  // RFC 5545：每行最多 75 bytes，中文一字 3 bytes，要依位元組切不能依字數切
  function foldLine(line) {
    const out = [];
    let cur = '', bytes = 0;
    for (const ch of line) {
      const b = utf8len(ch);
      if (bytes + b > 75) { out.push(cur); cur = ' ' + ch; bytes = 1 + b; }
      else { cur += ch; bytes += b; }
    }
    out.push(cur);
    return out.join('\r\n');
  }
  // 台灣時間（UTC+8，無夏令時間）→ UTC 時間戳
  function twToUTC(date, time, plusHours = 0) {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const t = Date.UTC(y, m - 1, d, hh - 8 + plusHours, mm);
    return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  function stamp(now) { return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function compact(date) { return date.replace(/-/g, ''); }

  function buildICS(entries, opts = {}) {
    const now = opts.now || new Date();
    const from = opts.from || '';
    const hours = opts.interviewHours || 2;
    const L = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//nomowho//interview-crew//ZH-TW',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:廣編採訪排程', 'X-WR-TIMEZONE:Asia/Taipei'
    ];
    const pushEvent = ({ uid, date, time, summary, location, description, alarm }) => {
      L.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(now)}`);
      if (isTime(time)) {
        L.push(`DTSTART:${twToUTC(date, time)}`, `DTEND:${twToUTC(date, time, hours)}`);
      } else {
        L.push(`DTSTART;VALUE=DATE:${compact(date)}`, `DTEND;VALUE=DATE:${compact(addDays(date, 1))}`);
      }
      L.push(`SUMMARY:${icsEscape(summary)}`);
      if (location) L.push(`LOCATION:${icsEscape(location)}`);
      if (description) L.push(`DESCRIPTION:${icsEscape(description)}`);
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(summary)}`, `TRIGGER:${alarm}`, 'END:VALARM');
      L.push('END:VEVENT');
    };

    let count = 0;
    entries.forEach(([id, job]) => {
      if (!job) return;
      const crew = crewOf(job);
      const title = [job.client, job.topic].filter(Boolean).join(' ') || '廣編採訪';
      if (interviewOf(job) && (!from || job.interviewDate >= from)) {
        const desc = [
          job.interviewee ? `受訪者：${job.interviewee}` : '',
          ...crew.map(c => `${c.role || '人員'}：${c.name || ''}${c.dueDate ? `（交稿 ${fmtDate(c.dueDate)}）` : ''}`),
          job.note ? `備註：${job.note}` : ''
        ].filter(Boolean).join('\n');
        pushEvent({
          uid: `${id}-interview@interview-crew.nomowho`, date: job.interviewDate, time: job.interviewTime,
          summary: `採訪｜${title}`, location: job.location || '', description: desc,
          alarm: isTime(job.interviewTime) ? '-P1D' : '-PT15H'
        });
        count++;
      }
      crew.forEach((c, i) => {
        if (c.delivered || !isDate(c.dueDate) || (from && c.dueDate < from)) return;
        pushEvent({
          uid: `${id}-due-${c.personId || i}@interview-crew.nomowho`, date: c.dueDate, time: '',
          summary: `交稿｜${c.name || ''}（${c.role || '人員'}）${title}`,
          description: interviewOf(job) ? `採訪日：${fmtDate(job.interviewDate)}` : '免採訪',
          alarm: '-PT15H'
        });
        count++;
      });
    });
    L.push('END:VCALENDAR');
    return { text: L.map(foldLine).join('\r\n') + '\r\n', count };
  }

  // ── Outlook 會議邀請連結 ─────────────────────────────────────
  // 開 Outlook 網頁版「新增會議」，與會者＝有 Email 的成員；Nomo 確認後自己按傳送
  // 規格：https://interactiondesignfoundation.github.io/add-event-to-calendar-docs/services/outlook-web.html
  const OUTLOOK_COMPOSE = 'https://outlook.office.com/calendar/deeplink/compose';
  function twToISO(date, time, plusHours = 0) {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, d, hh - 8 + plusHours, mm)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  function htmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  // crew 每人需帶 name / role / dueDate / email；稿費一律不放進邀請（所有與會者都看得到）
  function buildInvite(job, opts = {}) {
    const hours = opts.interviewHours || 2;
    const crew = crewOf(job);
    const seen = new Set(), attendees = [], missing = [];
    crew.forEach(c => {
      const email = String(c.email || '').trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (!seen.has(email.toLowerCase())) { seen.add(email.toLowerCase()); attendees.push({ name: c.name || '', role: c.role || '', email }); }
      } else {
        missing.push({ name: c.name || '', role: c.role || '' });
      }
    });
    if (job.noInterview) return { url: '', attendees, missing, error: 'nointerview' };
    if (!isDate(job.interviewDate)) return { url: '', attendees, missing, error: 'nodate' };

    const title = [job.client, job.topic].filter(Boolean).join(' ') || '廣編採訪';
    const info = [
      job.client && `客戶：${htmlEsc(job.client)}`,
      job.topic && `主題：${htmlEsc(job.topic)}`,
      job.interviewee && `受訪者：${htmlEsc(job.interviewee)}`,
      job.issue && `刊期：${htmlEsc(job.issue)}`,
      job.location && `地點：${htmlEsc(job.location)}`
    ].filter(Boolean).join('<br>');
    const team = crew.map(c => `${htmlEsc(c.role || '人員')}　${htmlEsc(c.name)}${isDate(c.dueDate) ? `（交稿 ${fmtDate(c.dueDate)}）` : ''}`).join('<br>');
    const body = [
      info && `<p>${info}</p>`,
      team && `<p><b>採訪團隊</b><br>${team}</p>`,
      job.note && `<p>備註：${htmlEsc(job.note).replace(/\r?\n/g, '<br>')}</p>`
    ].filter(Boolean).join('');

    const params = [['subject', `採訪｜${title}`]];
    if (isTime(job.interviewTime)) {
      params.push(['startdt', twToISO(job.interviewDate, job.interviewTime)], ['enddt', twToISO(job.interviewDate, job.interviewTime, hours)]);
    } else {
      params.push(['startdt', job.interviewDate], ['enddt', job.interviewDate], ['allday', 'true']);
    }
    if (job.location) params.push(['location', job.location]);
    if (body) params.push(['body', body]);
    if (attendees.length) params.push(['to', attendees.map(a => a.email).join(',')]);
    const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return { url: `${OUTLOOK_COMPOSE}?path=/calendar/action/compose&rru=addevent&${query}`, attendees, missing };
  }

  // ── iPhone 行事曆邀請 ────────────────────────────────────────
  // 網頁無法替 iPhone 行事曆填「邀請對象」，所以只產生「採訪」這一個行程讓使用者加入，
  // Email 另外放剪貼簿，由使用者在行事曆的「邀請對象」貼上後 iPhone 才會寄出邀請
  function inviteText(job) {
    const crew = crewOf(job);
    const info = [
      job.client && `客戶：${job.client}`,
      job.topic && `主題：${job.topic}`,
      job.interviewee && `受訪者：${job.interviewee}`,
      job.issue && `刊期：${job.issue}`,
      job.location && `地點：${job.location}`
    ].filter(Boolean).join('\n');
    const team = crew.length
      ? ['採訪團隊', ...crew.map(c => `${c.role || '人員'}　${c.name || ''}${isDate(c.dueDate) ? `（交稿 ${fmtDate(c.dueDate)}）` : ''}`)].join('\n')
      : '';
    // 稿費一律不放：受邀者都看得到這段說明
    return [info, team, job.note ? `備註：${job.note}` : ''].filter(Boolean).join('\n\n');
  }
  function buildInviteICS(id, job, opts = {}) {
    if (job.noInterview) return { error: 'nointerview' };
    if (!isDate(job.interviewDate)) return { error: 'nodate' };
    const now = opts.now || new Date();
    const hours = opts.interviewHours || 2;
    const title = [job.client, job.topic].filter(Boolean).join(' ') || '廣編採訪';
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//nomowho//interview-crew//ZH-TW', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${id || 'new'}-interview@interview-crew.nomowho`, `DTSTAMP:${stamp(now)}`];
    if (isTime(job.interviewTime)) {
      L.push(`DTSTART:${twToUTC(job.interviewDate, job.interviewTime)}`, `DTEND:${twToUTC(job.interviewDate, job.interviewTime, hours)}`);
    } else {
      L.push(`DTSTART;VALUE=DATE:${compact(job.interviewDate)}`, `DTEND;VALUE=DATE:${compact(addDays(job.interviewDate, 1))}`);
    }
    L.push(`SUMMARY:${icsEscape(`採訪｜${title}`)}`);
    if (job.location) L.push(`LOCATION:${icsEscape(job.location)}`);
    const desc = inviteText(job);
    if (desc) L.push(`DESCRIPTION:${icsEscape(desc)}`);
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(`採訪｜${title}`)}`, `TRIGGER:${isTime(job.interviewTime) ? '-P1D' : '-PT15H'}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR');
    return { text: L.map(foldLine).join('\r\n') + '\r\n' };
  }
  // iPhone 行事曆的 calshow: 網址，數字是從 2001-01-01 UTC 起算的秒數，會直接跳到那一天
  function calshowURL(date, time) {
    if (!isDate(date)) return 'calshow:';
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = isTime(time) ? time.split(':').map(Number) : [9, 0];
    return `calshow:${Math.round((Date.UTC(y, m - 1, d, hh - 8, mm) - Date.UTC(2001, 0, 1)) / 1000)}`;
  }

  return {
    TZ, todayTW, isDate, isTime, diffDays, addDays, weekday, fmtDate, level, inviteText, buildInviteICS, calshowURL,
    crewOf, feeOf, interviewOf, anchorDate, jobStatus, reminderItems, monthlyFees,
    icsEscape, foldLine, twToUTC, buildICS, twToISO, buildInvite
  };
});
