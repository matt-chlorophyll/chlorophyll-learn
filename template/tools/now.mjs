#!/usr/bin/env node
// now.mjs — 按学习者的时区输出现在的日期和时间
// "今天""昨天"、manifest 里每节课的 date、生成记录的时间都用它，不用 date 命令（那是电脑的时区）。
// 时区取 learner/profile.md「节奏与时长」里的「时区：」一行，可以写 UTC+8、UTC-5、UTC+5:30、GMT+8，
// 或者 IANA 名称（Asia/Shanghai、America/New_York，自动处理夏令时）。没写或看不懂时用电脑的时区，并提示。
// serve.mjs 也用它给学习事件打时间戳。
// 用法：
//   node tools/now.mjs          2026-10-25 周日 21:03（UTC+8，学习者时区）
//   node tools/now.mjs --json   {"date":"2026-10-25","weekday":"周日","time":"21:03:12","offset":"+08:00","timezone":"UTC+8","source":"profile"}

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = n => String(n).padStart(2, '0');
const fmtOffset = min => `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;

// 把 profile 里的写法规范成 UTC±H[:MM] 或 IANA 名称；看不懂返回 null
export function parseTimezone(s) {
  if (!s) return null;
  const iana = /\b[A-Z][A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/.exec(s)?.[0];
  if (iana) {
    try { new Intl.DateTimeFormat('en', { timeZone: iana }); return iana; } catch { /* 不是合法的 IANA 名称 */ }
  }
  const m = /(?:UTC|GMT)\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?/i.exec(s);
  if (m && Number(m[2]) <= 14 && Number(m[3] ?? 0) < 60) return `UTC${m[1] === '+' ? '+' : '-'}${Number(m[2])}${m[3] && m[3] !== '00' ? `:${m[3]}` : ''}`;
  if (/^\s*(UTC|GMT)\s*(\(|（|$)/i.test(s)) return 'UTC+0';
  if (/北京时间|东八区/.test(s)) return 'UTC+8';
  return null;
}

// 读 learner/profile.md 的时区：{ timezone（规范后的，看不懂或没写是 null）, raw（原文，没写是 null） }
export function learnerTimezone(root) {
  const file = path.join(root, 'learner', 'profile.md');
  const line = existsSync(file) ? /^\s*-\s*时区\s*[:：]\s*(.*)$/m.exec(readFileSync(file, 'utf8'))?.[1].trim() : null;
  const raw = !line || /^[（(]|例如/.test(line) ? null : line; // 模板里的占位说明不算
  return { timezone: parseTimezone(raw), raw };
}

// 某个时区里的日期、星期、时间、UTC 偏移；timezone 为 null 时用电脑的时区
export function nowIn(timezone, d = new Date()) {
  const off = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/.exec(timezone ?? '');
  if (off) {
    const min = (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] ?? 0));
    const t = new Date(d.getTime() + min * 60000);
    return { date: t.toISOString().slice(0, 10), weekday: WEEKDAY[t.getUTCDay()], time: t.toISOString().slice(11, 19), offset: fmtOffset(min) };
  }
  if (timezone) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
    }).formatToParts(d).map(x => [x.type, x.value]));
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      weekday: WEEKDAY[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)],
      time: `${p.hour}:${p.minute}:${p.second}`,
      offset: p.timeZoneName.replace(/^GMT/, '') || '+00:00',
    };
  }
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    weekday: WEEKDAY[d.getDay()],
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    offset: fmtOffset(-d.getTimezoneOffset()),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { timezone, raw } = learnerTimezone(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const now = nowIn(timezone);
  // 没有学习者时区时，把电脑的偏移写成 UTC±H[:MM]
  const machine = `UTC${now.offset[0]}${Number(now.offset.slice(1, 3))}${now.offset.endsWith(':00') ? '' : now.offset.slice(3)}`;
  const out = { ...now, timezone: timezone ?? machine, source: timezone ? 'profile' : 'computer' };
  if (process.argv.includes('--json')) console.log(JSON.stringify(out));
  else {
    console.log(`${now.date} ${now.weekday} ${now.time.slice(0, 5)}（${out.timezone}，${timezone ? '学习者时区' : '电脑时区'}）`);
    if (!timezone) console.log(raw ? `看不懂 learner/profile.md 里的时区「${raw}」，先用电脑的时区。写成 UTC+8 或 Asia/Shanghai 这样。` : 'learner/profile.md 里还没写时区，先用电脑的时区。');
  }
}
