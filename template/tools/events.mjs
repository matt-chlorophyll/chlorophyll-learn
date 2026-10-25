#!/usr/bin/env node
// events.mjs — 把 learner/events.jsonl 压缩成按课程汇总的 markdown（/today、周复盘用；不要直接读整个 events.jsonl）
//
// 用法：node tools/events.mjs [--since <时间>] [--until <时间>] [--prefix <路径前缀>] [--lab]
//   --since/--until：ISO 日期或时间，如 2026-10-19 或 2026-10-19T21:00（按事件的本地时间比较）
//   --prefix：只看某个路径下的课程，如 lessons/<topic>/w01
//   --lab：包含 /lab/ 下的测试页（默认排除）
//   --answers <课程路径>：只列那节课你当时的作答和留言（带 ts），写回看快照用（data-was、data-at），如 lessons/<topic>/w00/d0
// 输出末尾的「最后一条事件时间」可以记进 learner/state.md，下次用 --since 接着处理。

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'learner', 'events.jsonl');

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const since = flag('since'), until = flag('until');
const prefix = flag('prefix') && `/${flag('prefix').replaceAll('\\', '/').replace(/^[A-Za-z]:\/.*?\/Git\//, '').replace(/^\/+/, '')}`;
const includeLab = argv.includes('--lab');
const answersOf = flag('answers') && `/${flag('answers').replaceAll('\\', '/').replace(/^[A-Za-z]:\/.*?\/Git\//, '').replace(/^(.*\/)?site\//, '').replace(/^\/+/, '').replace(/index\.html$/, '').replace(/\/?$/, '/')}`;

if (!existsSync(FILE)) { console.log('还没有任何学习事件（learner/events.jsonl 不存在）。'); process.exit(0); }

const events = (await readFile(FILE, 'utf8')).split(/\r?\n/).filter(Boolean).flatMap(l => {
  try { return [JSON.parse(l)]; } catch { return []; }
}).filter(e => (!since || e.ts >= since) && (!until || e.ts < until));

// 先猜题：id p1、p2…，选择题和回想题都有（新事件另有 guess: true）。「还不确定」：选项 x（新事件另有 unsure: true），和答错分开写
const isGuess = a => a.guess === true || /^p\d+$/.test(a.id);
const isUnsure = a => a.unsure === true || (a.kind === 'choice' && a.choice === 'x' && a.correct !== true);
const missOf = a => (a.kind === 'reveal' ? `${a.id}(自评 ${a.self})` : isUnsure(a) ? `${a.id}(还不确定)` : `${a.id}(选 ${a.choice})`);

// 写回看快照用：一节课里每道题的第一次作答、打卡和留言，原样带上 ts（快照的 data-at）
if (answersOf) {
  const evs = events.filter(e => e.page === answersOf || e.page === `${answersOf}index.html`);
  const seen = new Set();
  console.log(`# ${answersOf} 当时的作答和留言`);
  for (const a of evs.filter(e => e.type === 'quiz_answer')) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    console.log(a.kind === 'reveal' ? `- 题 ${a.id}：自评 ${a.self}${a.note ? `，写了 ${JSON.stringify(a.note)}` : ''}（${a.ts}）` : `- 题 ${a.id}：选 ${a.choice}${a.correct ? '（对）' : isUnsure(a) ? '（还不确定）' : ''}（${a.ts}）`);
  }
  const ck = evs.filter(e => e.type === 'checkin').at(-1);
  console.log(ck ? `- 打卡 ts=${ck.ts}：上面没列出的题，算当时跳过了（data-was="skip"）` : '- 没有打卡记录：没列出的题写不了 data-was，小窗会显示"没找到当时的作答"');
  if (ck) for (const f of ['explain', 'unclear', 'note']) if (ck[f]) console.log(`  - 打卡 ${f}：${JSON.stringify(ck[f])}`);
  for (const c of evs.filter(e => e.type === 'capture')) console.log(`- 「这里没懂」ts=${c.ts} 段 ${c.sec}：note ${JSON.stringify(c.note || '')}${c.quote ? `，选中 ${JSON.stringify(c.quote)}` : ''}`);
  for (const a of evs.filter(e => e.type === 'ask')) console.log(`- 问老师 ts=${a.ts} 段 ${a.sec}：question ${JSON.stringify(a.question)}`);
  process.exit(0);
}

// 组件和播放器在 iframe 里，page 是 …/dN/media/<id>/scene.html 或 …/dN/viz/<id>.html，归到所在的课程
const lessonOf = page => (page || '').replace(/(media\/[^/]+\/[^/]*|viz\/[^/]+)$/, '').replace(/index\.html$/, '');
const lessons = new Map();
for (const e of events) {
  const key = lessonOf(e.page);
  if (!includeLab && key.startsWith('/lab/')) continue;
  if (prefix && !key.startsWith(prefix)) continue;
  if (!lessons.has(key)) lessons.set(key, []);
  lessons.get(key).push(e);
}

const min = s => Math.round((s || 0) / 60);
const q = (s, n = 160) => `「${String(s).replace(/\s+/g, ' ').slice(0, n)}」`;
const KIND = { dig: '想深挖', weekend: '周末问', confused: '这里没懂' }; // 「想深挖」「周末问」按钮已经去掉，旧记录照常显示
const CAT = { now: '当场讲完', dig: '想深挖', weekend: '周末问' }; // 「问老师」的归类
const out = [];

for (const [key, evs] of [...lessons].sort((a, b) => a[1][0].ts.localeCompare(b[1][0].ts))) {
  const of = t => evs.filter(e => e.type === t);
  const opens = of('lesson_open');
  const progress = [...of('lesson_progress'), ...of('lesson_pause'), ...of('lesson_resume'), ...of('checkin')];
  const last = progress.reduce((a, e) => ((e.active_s || 0) >= (a?.active_s || 0) ? e : a), null);
  const est = last?.est ?? opens.at(-1)?.est;
  out.push(`## ${key}`);
  out.push(`- 打开 ${opens.length} 次（${evs[0].ts.slice(5, 16).replace('T', ' ')} 到 ${evs.at(-1).ts.slice(5, 16).replace('T', ' ')}）`);
  if (last) {
    const secs = Object.entries(last.secs || {}).map(([k, v]) => `${k} ${min(v)}`).join('，');
    out.push(`- 有效学习 ${min(last.active_s)} 分钟${est ? ` / 预计 ${est}（实际÷预计 = ${(last.active_s / 60 / est).toFixed(2)}）` : ''}${secs ? `；各段分钟：${secs}` : ''}`);
  }

  // 暂停：次数按点「暂停」算，时长取每次点「继续学习」时记下的 paused_s；没点继续就关掉或刷新页面的那次没有时长
  const pauses = of('lesson_pause'), resumes = of('lesson_resume');
  if (pauses.length) {
    const left = pauses.length - resumes.length;
    out.push(`- 暂停 ${pauses.length} 次，共 ${min(resumes.reduce((s, e) => s + (e.paused_s || 0), 0))} 分钟${left > 0 ? `（其中 ${left} 次没点继续就离开了页面，不算时长）` : ''}`);
  }

  // 犯困了：每次点开时已学几分钟（和页面顶部「已学 N 分钟」一样向下取整）、在读哪一段，括号里是当时的钟点
  const sleepy = of('lesson_sleepy');
  if (sleepy.length) {
    out.push(`- 犯困 ${sleepy.length} 次：${sleepy.map(e => `已学 ${Math.floor((e.active_s || 0) / 60)} 分钟，${e.title ? `读到「${e.title}」` : '还没读到第 1 段'}（${e.ts.slice(11, 16)}）`).join('；')}`);
  }

  // 小测：每题只算第一次作答。先猜题单独一行，不计入得分
  const firstAnswer = new Map();
  for (const a of of('quiz_answer')) if (!firstAnswer.has(a.id)) firstAnswer.set(a.id, a);
  if (firstAnswer.size) {
    const all = [...firstAnswer.values()];
    const scored = all.filter(a => !isGuess(a)), guesses = all.filter(isGuess);
    if (scored.length) {
      const score = scored.reduce((s, a) => s + (a.correct === true ? 1 : a.correct === false ? 0 : Number(a.correct) || 0), 0);
      const misses = scored.filter(a => a.correct !== true && a.correct !== 1).map(missOf);
      out.push(`- 小测 ${scored.length} 题${guesses.length ? '（不含先猜）' : ''}，得分 ${score}/${scored.length} = ${Math.round((score / scored.length) * 100)}%${misses.length ? `；没拿满：${misses.join('，')}` : ''}`);
    }
    if (guesses.length) {
      const misses = guesses.filter(a => a.correct !== true && a.correct !== 1).map(missOf);
      out.push(`- 先猜 ${guesses.length} 题（不计分），猜中 ${guesses.length - misses.length}${misses.length ? `；没猜中：${misses.join('，')}` : ''}`);
    }
  }

  const ck = of('checkin').at(-1);
  if (ck) {
    out.push(`- 打卡：难度 ${ck.difficulty}/5，自报 ${ck.minutes} 分钟${ck.helpful?.length ? `，有帮助：${ck.helpful.join('，')}` : ''}`);
    if (ck.explain) out.push(`  - 讲给老师听：${q(ck.explain, 600)}`);
    if (ck.unclear) out.push(`  - 没懂：${q(ck.unclear)}`);
    if (ck.note) out.push(`  - 留言：${q(ck.note)}`);
  } else out.push('- 还没打卡');

  for (const c of of('capture')) {
    out.push(`- [${KIND[c.kind] ?? c.kind}] 段 ${c.sec ?? '?'}：${c.quote ? q(c.quote) : ''}${c.note ? ` → ${q(c.note)}` : ''}（${c.ts.slice(5, 16).replace('T', ' ')}）`);
  }

  // 网页「问老师」：只列问题和老师的归类（想深挖带上概念标签）；稍后看的（点了「发送，稍后看」，或者回答中途点了「稍后看」）标在前面；
  // 做题时只给了提示、学习者要了答案、页面没收到回答也标出来。改版前的记录没有 cat：有 parked（停车场标签）的算想深挖
  for (const a of of('ask')) {
    const cat = a.cat ?? (a.ok === false ? null : a.parked ? 'dig' : 'now');
    const tag = a.tag ?? a.parked;
    const how = cat ? ` → ${CAT[cat]}${cat === 'dig' && tag ? `：${tag}` : ''}` : '';
    out.push(`- [问老师${a.later ? '·稍后看' : ''}] 段 ${a.sec ?? '?'}：${a.quote ? `（选中 ${q(a.quote)}）` : ''}${q(a.question)}${how}${a.hint ? ' → 只给了提示' : ''}${a.revealed ? ' → 看了答案' : ''}${a.unseen ? '（页面没收到回答）' : ''}${a.ok === false ? `（没答上：${a.error ?? '?'}）` : ''}（${a.ts.slice(5, 16).replace('T', ' ')}）`);
  }

  // 配音动画：每个动画取最远播放位置
  const media = new Map();
  for (const m of evs.filter(e => e.type?.startsWith('media_'))) {
    const id = (m.media || '').split('/').pop() || '?';
    const s = media.get(id) || { max: 0, duration: m.duration, speed: null, ended: false };
    if (m.max != null) s.max = Math.max(s.max, m.max);
    if (m.duration) s.duration = m.duration;
    if (m.type === 'media_speed') s.speed = m.speed;
    if (m.type === 'media_tts') s.tts = m.on;
    if (m.type === 'media_ended') s.ended = true;
    media.set(id, s);
  }
  if (media.size) {
    out.push(`- 配音动画：${[...media].map(([id, s]) => `${id} ${s.ended ? '看完' : `到 ${s.duration ? Math.round((s.max / s.duration) * 100) : '?'}%`}${s.speed && s.speed !== 1 ? `（${s.speed}×）` : ''}${s.tts === false ? '（关了浏览器朗读）' : ''}`).join('，')}`);
  }

  // 回看：点开了哪些回指（ref），同一处点了几次
  const recalls = of('recall_open');
  if (recalls.length) {
    const by = new Map();
    for (const r of recalls) by.set(r.ref, (by.get(r.ref) || 0) + 1);
    out.push(`- 回看 ${recalls.length} 次：${[...by].map(([ref, n]) => `${ref}${n > 1 ? ` ×${n}` : ''}`).join('，')}`);
  }

  const viz = new Map();
  for (const v of evs.filter(e => e.viz)) viz.set(v.viz, (viz.get(v.viz) || 0) + 1);
  if (viz.size) out.push(`- 交互：${[...viz].map(([id, n]) => `${id} ${n} 次操作`).join('，')}`);
  out.push('');
}

if (!out.length) console.log('这个时间范围内没有学习事件。');
else console.log(out.join('\n'));
if (events.length) console.log(`最后一条事件时间：${events.at(-1).ts}`);
