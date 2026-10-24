// lesson.js — 课程页运行时（所有视觉主题共用）
//
// writer 只写结构化的 HTML（契约见 platform/style-guide.md「课程页结构」），这里负责：
// - 按主题加载样式和 theme.js（lh-theme.js；主题怎么写见 /assets/themes/README.md）
// - 顶部条、侧边的今日路线（目录 + 当前位置标记）、页头的路线概览、段落编号和分钟数、🔭/🧗 页边标签
// - 填充插槽 <lh-media id> / <lh-viz id>；缺失的组件显示 MISSING 框
// - 小测 <lh-quiz>、课末打卡 <lh-checkin>、「问老师」面板（lh-ask.js，按钮上有未读回答的角标）和「这里没懂」
// - 统计有效学习时间（页面可见且 90 秒内有操作，或配音动画在播放），上报到 /api/event
// - 暂停：虚化层 .lh-pause 盖住整页，计时停下、配音动画暂停，只有「继续学习」能点；刷新后不保留
// - 犯困了：提示框 .lh-sleepy 列出马上能做的几件事，可以从这里直接暂停；每次点开记一条 lesson_sleepy
// - 回指回看（lh-recall.js）：正文里的 <lh-recall> 点开小窗，看之前学过的题、讲解、留言的快照
// - 从回看的「去原文」打开（?from=recall）时只读：不计时，不记进度、作答和打卡，停在锚点上
// - QA 钩子 window.__LESSON：{ ready, theme, slots, errors, sections, quizzes, recalls, est }
//
// DOM 结构、类名和状态由这里统一生成，所有主题都一样；主题只负责外观（CSS）和装饰（theme.js 的 setup）。

import { log as send, QA_MODE } from './lh-log.js';
import { resolveTheme, themeUrl, loadCss, reveal } from './lh-theme.js';
import { createAsk } from './lh-ask.js';
import { createRecall, land } from './lh-recall.js';

const main = document.querySelector('main.lesson');
const PAGE = location.pathname;
const QA = (window.__LESSON = { ready: false, theme: null, slots: { total: 0, filled: 0, missing: [] }, errors: [], warnings: [], sections: [], quizzes: 0, recalls: 0, est: 0 });
addEventListener('error', e => QA.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener('unhandledrejection', e => QA.errors.push(`unhandledrejection: ${e.reason}`));

// 从回看的「去原文」打开的旧课（?from=recall）：只读。不计时、不记进度和作答、不能打卡，学习记录里也不记这一页的事件
const READONLY = new URLSearchParams(location.search).get('from') === 'recall';
const log = (type, data) => { if (!READONLY) send(type, data); };

const store = {
  get(k, d) { try { const v = localStorage.getItem(`lh:${PAGE}:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`lh:${PAGE}:${k}`, JSON.stringify(v)); } catch { /* 隐私模式等，忽略 */ } },
};

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter(x => x != null && x !== false));
  return e;
}

// 需要确认服务器收到的事件（打卡、捕获）用 fetch；其余用 sendBeacon
async function post(type, data) {
  if (QA_MODE) return true;
  try {
    const r = await fetch('/api/event', { method: 'POST', body: JSON.stringify({ type, page: PAGE, ...data }), keepalive: true });
    return r.ok;
  } catch { return false; }
}

let toastTimer;
function toast(msg) {
  let t = document.querySelector('.lh-toast');
  if (!t) document.body.append((t = h('div', { class: 'lh-toast', role: 'status' })));
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

if (!main) throw new Error('lesson.js：页面里没有 <main class="lesson">');

// ---------- 主题 ----------

// 主题可以在 theme.js 的 options 里覆盖这些（labels 按键合并）
const DEFAULTS = {
  number: n => String(n), // 段落编号的写法（目录和段落标题共用）
  labels: {
    back: '← 本周',
    toc: '今日路线',
    later: '后面会讲',
    stretch: 'Stretch',
    media: '配音动画',
    viz: '交互',
    quiz: (n, total) => `小测 ${n}/${total}`,
    reveal: '回想题',
    done: '已打卡',
    statRoute: '路线',
    statTerms: '术语',
    checkinSub: '两分钟就好。老师会根据这些调整明天的内容。',
  },
};
const THEME = await resolveTheme();
QA.theme = THEME;
const [mod] = await Promise.all([
  import(themeUrl(THEME, 'theme.js')).catch(e => { QA.errors.push(`主题 ${THEME} 的 theme.js 加载失败：${e.message}`); return {}; }),
  loadCss(themeUrl(THEME, 'lesson.css')),
  loadCss('/assets/lh-recall.css'), // 排在主题样式前面：主题可以覆盖
]);
const T = { ...DEFAULTS, ...(mod.options || {}), labels: { ...DEFAULTS.labels, ...(mod.options?.labels || {}) } };
if (QA_MODE) document.documentElement.classList.add('lh-still'); // QA 截图：一次性的动效直接画到终点

// 给主题的事件。progress、checkin 会记住最后一次，晚订阅的主题也能立刻拿到当前状态
const listeners = {}, last = {};
function emit(type, detail) {
  last[type] = detail;
  for (const fn of listeners[type] || []) {
    try { fn(detail); } catch (e) { QA.errors.push(`[主题 ${THEME}] ${type} 回调出错：${e.message}`); }
  }
}

// ---------- 段落 ----------

const sections = [...main.querySelectorAll(':scope > section[data-sec]')].map((s, i) => {
  const h2 = s.querySelector(':scope > h2');
  const title = h2?.textContent.trim() || s.dataset.sec;
  const min = Number(s.dataset.min) || 0;
  if (!s.id) s.id = `sec-${s.dataset.sec}`;
  if (!h2) QA.warnings.push(`段落 ${s.dataset.sec} 没有 <h2>`);
  if (!min) QA.warnings.push(`段落 ${s.dataset.sec} 没有 data-min`);
  if (h2) {
    // 段落标题：编号、标题、细线、分钟数（顺序和显示与否由主题的 CSS 决定）
    const ttl = h('span', { class: 'ttl' });
    while (h2.firstChild) ttl.append(h2.firstChild);
    h2.append(h('span', { class: 'n', 'data-n': i + 1 }, T.number(i + 1)), ttl,
      h('span', { class: 'rule', 'aria-hidden': 'true' }), h('span', { class: 'min' }, `${min} 分钟`));
  }
  const stretch = s.hasAttribute('data-stretch');
  if (stretch) {
    const tag = h('aside', { class: 'stretch-tag' },
      h('span', { class: 'tag' }, h('span', { class: 'emo' }, '🧗'), T.labels.stretch),
      h('p', {}, s.dataset.stretch || '这一段有点挑战，没完全懂也正常。先抓住大意，周末还会再练。'));
    h2 ? h2.after(tag) : s.prepend(tag);
  }
  return { el: s, id: s.dataset.sec, title, min, stretch, index: i };
});
for (const a of main.querySelectorAll('aside.later')) {
  if (!a.querySelector('.tag')) a.prepend(h('span', { class: 'tag' }, h('span', { class: 'emo' }, '🔭'), T.labels.later));
}
const ids = sections.map(s => s.id);
if (new Set(ids).size !== ids.length) QA.warnings.push(`data-sec 有重复：${ids.join(', ')}`);

const est = sections.reduce((a, s) => a + s.min, 0) || Number(main.dataset.est) || 0;
QA.est = est;
QA.sections = sections.map(({ id, title, min, stretch }) => ({ id, title, min, stretch }));
if (main.dataset.est && Number(main.dataset.est) !== est) QA.warnings.push(`data-est=${main.dataset.est} 与各段 data-min 之和 ${est} 不一致`);

// 本课术语：正文里第一次出现的术语（<dfn>），读到它所在的段落就算"见过"
const codex = [];
for (const d of main.querySelectorAll('section[data-sec] dfn')) {
  const text = d.textContent.trim();
  if (text && !codex.some(c => c.text === text)) codex.push({ text, sec: d.closest('section[data-sec]').dataset.sec, el: d, got: false });
}

// ---------- 顶部条、侧边今日路线、页头路线概览 ----------

const head = main.querySelector('.lesson-head');
const hubLink = main.dataset.hub || '/';
const mini = h('div', { class: 'lh-mini', 'aria-hidden': 'true' },
  sections.map(s => h('span', { class: s.stretch ? 'stretch' : null, style: `flex:${Math.max(1, s.min)}` })));
const clock = h('span', { class: 'lh-clock' });
const trackNo = h('b', { class: 'no' }), trackT = h('span', { class: 't' });
const top = h('div', { class: 'lh-top' },
  h('a', { class: 'lh-back', href: hubLink }, T.labels.back),
  h('span', { class: 'lh-title' }, document.querySelector('h1')?.textContent.trim() ?? ''),
  h('span', { class: 'lh-track', title: '正在读的这一段' }, trackNo, trackT),
  mini, clock);
document.body.prepend(top);

// 侧边今日路线：一直可见的目录。当前段用 .lh-toc-mark 标出，位置写在 .lh-toc-body 的 --mark-y / --mark-h 上
const tocCount = h('span', { class: 'lh-toc-count' }, `0/${sections.length}`);
const tocList = h('ol', {}, sections.map(s => h('li', { class: s.stretch ? 'stretch' : null },
  h('a', { href: `#${s.el.id}`, title: s.title },
    h('span', { class: 'no' }, T.number(s.index + 1)), h('span', { class: 't' }, s.title), h('span', { class: 'm' }, `${s.min} 分`)))));
const tocMark = h('span', { class: 'lh-toc-mark', 'aria-hidden': 'true', hidden: true });
const tocBody = h('div', { class: 'lh-toc-body' }, tocList, tocMark);
const toc = h('nav', { class: 'lh-toc', 'aria-label': T.labels.toc },
  h('p', { class: 'lh-toc-h' }, h('span', { class: 'lbl' }, T.labels.toc), tocCount), tocBody);
main.prepend(toc);

// 页头路线概览：按分钟数等比例的一排段落（主题可以隐藏、改画法或换成自己的装饰）
const route = h('nav', { class: 'lh-route', 'aria-label': '路线概览' },
  h('ol', {}, sections.map(s => h('li', { class: s.stretch ? 'stretch' : null, style: `flex:${Math.max(1, s.min)}` },
    h('a', { href: `#${s.el.id}`, title: s.title, tabindex: -1 },
      h('span', { class: 'seg' }), h('span', { class: 't' }, s.title), h('span', { class: 'm' }, `${s.min} 分`))))),
  h('p', { class: 'lh-route-total' }, `今天共 ${sections.length} 段，预计 ${est} 分钟。`));
head ? head.append(route) : main.prepend(route);

// ---------- 有效学习时间 + 当前段落 ----------

const time = store.get('time', { total: 0, secs: {} });
const seen = new Set(store.get('seen', []));
let current = null;
let lastInput = Date.now();
let paused = null; // 暂停中是 { at: 开始的时间, focus: 暂停前的焦点 }；只在内存里，刷新页面就回到正常状态
for (const ev of ['scroll', 'pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
  addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true });
}

function mediaPlaying() {
  for (const f of document.querySelectorAll('.lh-media iframe')) {
    try { if (f.contentDocument?.querySelector('.lh-player.playing')) return true; } catch { /* 忽略 */ }
  }
  return false;
}

const checkinEl = main.querySelector('lh-checkin');

// 状态：读过（到过、且不是正在读的那段；打卡后正在读的那段也算）→ .seen / .is-done；正在读 → .now / .is-now
function paint() {
  const cur = current, finished = !!store.get('done', null);
  const tocLis = tocList.children, routeLis = route.querySelectorAll('li'), spans = mini.querySelectorAll('span');
  let n = 0;
  sections.forEach((s, i) => {
    const done = seen.has(s.id) && (s !== cur || finished);
    if (done) n++;
    for (const x of [tocLis[i], routeLis[i], spans[i]]) {
      x.classList.toggle('seen', done);
      x.classList.toggle('now', s === cur);
    }
    s.el.classList.toggle('is-done', done);
    s.el.classList.toggle('is-now', s === cur);
  });
  tocCount.textContent = `${n}/${sections.length}`;
  trackNo.textContent = cur ? `${cur.index + 1}/${sections.length}` : `0/${sections.length}`;
  trackT.textContent = cur ? cur.title : '还没开始';
  for (const c of codex) c.got = seen.has(c.sec);
  checkinEl?.classList.toggle('is-done', finished);
  placeMark();
  ask.context();
  emit('progress', { current: cur, seen, finished, done: n, total: sections.length });
}

function placeMark() {
  const li = current ? tocList.children[current.index] : null;
  tocMark.hidden = !li;
  if (!li) return;
  const b = tocBody.getBoundingClientRect(), r = li.getBoundingClientRect();
  tocBody.style.setProperty('--mark-y', `${Math.round(r.top - b.top)}px`);
  tocBody.style.setProperty('--mark-h', `${Math.round(r.height)}px`);
}

function updateCurrent() {
  const line = innerHeight * 0.4;
  let cur = null;
  for (const s of sections) if (s.el.getBoundingClientRect().top < line) cur = s;
  if (scrollY + innerHeight >= document.documentElement.scrollHeight - 4) cur = sections.at(-1) ?? cur; // 滚到底
  if (cur === current) return;
  current = cur;
  if (cur && !READONLY) { seen.add(cur.id); store.set('seen', [...seen]); }
  paint();
}
let scrollRaf = 0;
addEventListener('scroll', () => { cancelAnimationFrame(scrollRaf); scrollRaf = requestAnimationFrame(updateCurrent); }, { passive: true });
addEventListener('resize', () => { updateCurrent(); placeMark(); });

// 打卡表单的「实际学了多久」：还没打卡、学习者也没改过时，跟着页首的分钟数走
let autoMinutes = null;
function renderClock() {
  const m = Math.floor(time.total / 60);
  clock.textContent = est ? `已学 ${m} 分钟，预计 ${est} 分钟` : `已学 ${m} 分钟`;
  clock.classList.toggle('over', !!est && m > est * 1.25);
  clock.title = est && m > est * 1.25 ? '已经明显超出预计。可以先打卡，剩下的留到周末。' : '页面可见且最近有操作（或配音动画在播放）时才计时';
  if (autoMinutes) autoMinutes.value = Math.max(1, m);
}

setInterval(() => {
  const active = !READONLY && !paused && document.visibilityState === 'visible' && (Date.now() - lastInput < 90_000 || mediaPlaying());
  if (!active) return;
  time.total++;
  if (current) time.secs[current.id] = (time.secs[current.id] || 0) + 1;
  if (time.total % 10 === 0) store.set('time', time);
  if (time.total % 60 === 0) renderClock();
}, 1000);

const snapshot = () => ({ active_s: time.total, secs: time.secs, seen: [...seen], est });
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && !READONLY) { store.set('time', time); log('lesson_progress', snapshot()); }
});

// ---------- 插槽 ----------

async function ok(url, method = 'HEAD') {
  try { return (await fetch(url, { method, cache: 'no-store' })).ok; } catch { return false; }
}
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const sectionOf = node => node.closest('section[data-sec]')?.dataset.sec ?? null;

function missing(slot, what) {
  QA.slots.missing.push(what);
  slot.replaceWith(h('div', { class: 'lh-missing', role: 'alert' }, `MISSING：${what}`));
}

async function fillMedia(slot) {
  const id = slot.getAttribute('id');
  const base = `media/${id}/`;
  const [scene, tl] = await Promise.all([
    ok(`${base}scene.html`),
    fetch(`${base}timeline.json`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (!scene || !tl) return missing(slot, `配音动画 ${base}（${!scene ? 'scene.html' : 'timeline.json'} 不存在）`);
  const title = slot.getAttribute('title') || '';
  slot.replaceWith(h('figure', { class: 'lh-slot lh-media wide', 'data-id': id },
    h('div', { class: 'screen' }, h('iframe', { src: `${base}scene.html?theme=${THEME}`, title: title || id, allow: 'fullscreen; autoplay' })),
    h('figcaption', {}, h('span', { class: 'kind' }, T.labels.media), title && h('span', { class: 'ttl' }, title),
      h('span', { class: 'dur' }, fmt(tl.duration)))));
  QA.slots.filled++;
}

async function fillViz(slot) {
  const id = slot.getAttribute('id');
  const src = `viz/${id}.html`;
  if (!(await ok(src))) return missing(slot, `交互组件 ${src}（不存在）`);
  const title = slot.getAttribute('title') || '';
  const hint = slot.getAttribute('hint') || '';
  const iframe = h('iframe', { src: `${src}?theme=${THEME}`, title: title || id, style: `height:${Number(slot.getAttribute('height')) || 420}px` });
  slot.replaceWith(h('figure', { class: `lh-slot lh-viz${slot.hasAttribute('wide') ? ' wide' : ''}`, 'data-id': id },
    iframe,
    (title || hint) && h('figcaption', {}, h('span', { class: 'kind' }, T.labels.viz), title && h('span', { class: 'ttl' }, title),
      hint && h('span', { class: 'hint' }, hint))));
  QA.slots.filled++;
}

// 交互组件（component.js）发来的消息：自动高度、事件、报错、活动心跳
addEventListener('message', e => {
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.lh || e.origin !== location.origin) return;
  const frame = [...document.querySelectorAll('.lh-slot iframe')].find(f => f.contentWindow === e.source);
  const fig = frame?.closest('.lh-slot');
  const id = fig?.dataset.id ?? '?';
  if (d.lh === 'height' && frame && fig.classList.contains('lh-viz')) frame.style.height = `${Math.ceil(d.h)}px`;
  else if (d.lh === 'activity') lastInput = Date.now();
  else if (d.lh === 'error') QA.errors.push(`[viz/${id}] ${d.msg}`);
  else if (d.lh === 'event' && typeof d.type === 'string') log(d.type, { ...(d.data || {}), viz: id, sec: fig ? sectionOf(fig) : null });
});

// ---------- 小测 ----------

function setupChoice(q, id, sec) {
  const answer = (q.getAttribute('answer') || '').trim().toLowerCase();
  const list = q.querySelector(':scope > ul, :scope > ol');
  const why = q.querySelector(':scope > .why');
  if (!list || !answer) { QA.warnings.push(`小测 ${id} 缺少选项列表或 answer`); return; }
  const qbox = h('div', { class: 'q' });
  for (const n of [...q.childNodes]) if (n !== list && n !== why) qbox.append(n);
  q.prepend(qbox);
  if (why) why.hidden = true;
  const opts = h('ul', { class: 'opts' });
  const items = [...list.querySelectorAll(':scope > li')];
  if (!items.some(li => (li.dataset.k || '').toLowerCase() === answer)) QA.warnings.push(`小测 ${id} 的 answer="${answer}" 不在选项里`);
  const buttons = items.map((li, i) => {
    const k = (li.dataset.k || String.fromCharCode(97 + i)).toLowerCase();
    const b = h('button', { type: 'button', 'data-k': k }, h('span', { class: 'k' }, k.toUpperCase()), h('span', { html: li.innerHTML }));
    opts.append(h('li', {}, b));
    return b;
  });
  list.replaceWith(opts);
  const verdict = h('p', { class: 'verdict', hidden: true });
  opts.after(verdict);

  const show = (choice, fresh) => {
    const right = choice === answer;
    for (const b of buttons) {
      b.disabled = true;
      if (b.dataset.k === answer) b.classList.add('right');
      else if (b.dataset.k === choice) b.classList.add('wrong');
      else b.classList.add('dim');
    }
    q.classList.add('is-answered');
    q.classList.toggle('is-right', right);
    q.classList.toggle('is-wrong', !right);
    verdict.hidden = false;
    verdict.className = `verdict ${right ? 'ok' : 'no'}`;
    verdict.textContent = right ? '答对了。' : `不对，正确答案是 ${answer.toUpperCase()}。`;
    if (why) why.hidden = false;
    emit('quiz', { id, q, kind: 'choice', right, choice, fresh });
  };
  const prev = store.get(`quiz:${id}`, null);
  if (prev) show(prev.choice, false);
  buttons.forEach(b => b.addEventListener('click', e => {
    const choice = b.dataset.k;
    if (!READONLY) store.set(`quiz:${id}`, { choice });
    log('quiz_answer', { id, sec, kind: 'choice', choice, correct: choice === answer });
    q.style.setProperty('--hit-x', `${e.offsetX}px`); // 主题做"从点击处扩散"之类的效果时用
    q.style.setProperty('--hit-y', `${e.offsetY}px`);
    show(choice, true);
  }));
}

const SELF = [['got', '想对了'], ['partial', '想到一部分'], ['missed', '没想到']];
function setupReveal(q, id, sec) {
  const why = q.querySelector(':scope > .why');
  if (!why) { QA.warnings.push(`小测 ${id}（reveal）缺少 .why 参考答案`); return; }
  const qbox = h('div', { class: 'q' });
  for (const n of [...q.childNodes]) if (n !== why) qbox.append(n);
  q.prepend(qbox);
  why.hidden = true;
  const note = h('textarea', { placeholder: '先在这里写下你的想法（可选），再看参考答案', rows: 2 });
  const btn = h('button', { type: 'button', class: 'reveal' }, '想好了，看参考答案');
  const self = h('div', { class: 'self', hidden: true }, '和参考答案比：');
  qbox.after(note, h('div', { class: 'reveal-row' }, btn));
  why.after(self);
  const rate = (k, quiet) => {
    for (const b of self.querySelectorAll('button')) b.classList.toggle('picked', b.dataset.k === k);
    q.classList.add('is-answered');
    if (!quiet && !READONLY) {
      store.set(`quiz:${id}`, { self: k, note: note.value });
      log('quiz_answer', { id, sec, kind: 'reveal', self: k, correct: k === 'got' ? 1 : k === 'partial' ? 0.5 : 0, note: note.value.slice(0, 500) });
    }
    emit('quiz', { id, q, kind: 'reveal', self: k, fresh: !quiet });
  };
  for (const [k, label] of SELF) self.append(h('button', { type: 'button', 'data-k': k, onclick: () => rate(k) }, label));
  const open = () => { why.hidden = false; self.hidden = false; btn.parentElement.hidden = true; q.classList.add('is-open'); };
  btn.addEventListener('click', open);
  const prev = store.get(`quiz:${id}`, null);
  if (prev?.self) { note.value = prev.note || ''; open(); rate(prev.self, true); }
}

const allQuiz = [...main.querySelectorAll('lh-quiz')];
const choiceTotal = allQuiz.filter(q => q.getAttribute('type') !== 'reveal').length;
const quizIds = new Set();
let choiceN = 0;
for (const q of allQuiz) {
  const id = q.getAttribute('id') || `q${quizIds.size + 1}`;
  if (quizIds.has(id)) QA.warnings.push(`小测 id 重复：${id}`);
  quizIds.add(id);
  const sec = sectionOf(q);
  const isReveal = q.getAttribute('type') === 'reveal';
  (isReveal ? setupReveal : setupChoice)(q, id, sec);
  q.prepend(h('div', { class: 'lh-qlabel' }, isReveal ? T.labels.reveal : T.labels.quiz(++choiceN, choiceTotal)));
  QA.quizzes++;
}

// ---------- 回指回看 ----------

// 正文里的 <lh-recall> 和 </main> 前的快照 <template data-recall>（规则见 platform/style-guide.md「回指回看」）
const recall = createRecall({ h, main, page: PAGE, log, warn: w => QA.warnings.push(w), paused: () => !!paused,
  onOpen: () => { closePop(); closeSleepy(); hideFloat(); } });
QA.recalls = recall.count;

// ---------- 课末打卡 ----------

const DIFF = ['太简单', '偏简单', '刚好', '偏难', '太难'];
function setupCheckin(slot) {
  const box = h('div', { class: 'lh-stub' });
  slot.append(box);

  // fresh = 刚刚提交（主题只在这时放庆祝动效）；之后再打开页面只显示静态的结算
  const renderDone = (fresh = false) => {
    autoMinutes = null;
    const data = store.get('checkin', null) || {};
    const reached = sections.filter(s => seen.has(s.id)).length;
    const got = codex.filter(c => seen.has(c.sec)).length;
    const stat = (k, v, unit) => h('div', {}, h('dt', {}, k), h('dd', {}, String(v), unit && h('small', {}, unit)));
    const emblem = h('div', { class: 'lh-emblem', 'aria-hidden': 'true' });
    const reward = h('div', { class: `lh-reward${fresh ? ' celebrate' : ''}` }, emblem,
      h('div', { class: 'lh-rtext' },
        h('h2', { class: 'rt' }, T.labels.done),
        h('p', { class: 'rs' }, main.querySelector('.lesson-when')?.textContent.trim() || '今天的课')));
    box.replaceChildren(
      h('div', { class: 'lh-done' }, reward,
        h('dl', { class: 'lh-stats' },
          stat(T.labels.statRoute, `${reached}/${sections.length}`),
          stat('用时', data.minutes ?? '—', '分钟'),
          codex.length ? stat(T.labels.statTerms, `${got}/${codex.length}`) : stat('小测', QA.quizzes, '道')),
        h('p', { class: 'lh-done-msg' }, '今天的内容到这里，学到的东西会进入周末复习。有问题随时点「问老师」，或者在 Claude Code 里问。')),
      h('p', { class: 'lh-done-edit' }, h('button', { type: 'button', class: 'lh-btn ghost', onclick: renderForm }, '修改打卡')));
    emit('checkin', { fresh, box, reward, emblem });
  };

  function renderForm() {
    const prev = store.get('checkin', null);
    const minutes = h('input', { type: 'number', name: 'minutes', min: 0, max: 300, value: prev?.minutes ?? Math.max(1, Math.floor(time.total / 60)),
      oninput: () => { autoMinutes = null; } });
    autoMinutes = prev ? null : minutes; // 打过卡再修改：显示上次提交的值，不跟着走
    const scale = h('div', { class: 'lh-scale' }, DIFF.map((t, i) =>
      h('label', {}, h('input', { type: 'radio', name: 'difficulty', value: i + 1, checked: prev?.difficulty === i + 1 }),
        h('span', { class: 'key' }, String(i + 1)), h('span', { class: 'dt' }, t))));
    const chips = h('div', { class: 'lh-chips' }, sections.map(s =>
      h('label', {}, h('input', { type: 'checkbox', name: 'helpful', value: s.id, checked: prev?.helpful?.includes(s.id) }), s.title)));
    // 讲给老师听：不看页面、用自己的话讲一遍（自我解释），/today 第二天回应
    const explain = h('textarea', { name: 'explain', placeholder: '用你自己的话说，讲错了也没关系' });
    const unclear = h('textarea', { name: 'unclear', placeholder: '哪个概念、哪一段？说个大概就行' });
    const note = h('textarea', { name: 'note', placeholder: '比如：动画太快、文字太多、这种小测很有用、声音想换……' });
    explain.value = prev?.explain ?? '';
    unclear.value = prev?.unclear ?? '';
    note.value = prev?.note ?? '';
    const err = h('p', { class: 'lh-err', hidden: true });
    const submit = h('button', { type: 'submit', class: 'lh-btn' }, '提交打卡');
    const form = h('form', {},
      h('div', { class: 'lh-field' }, h('label', {}, '讲给老师听：这节课最重要的是什么', h('span', { class: 'hint' }, '可选，但最值得写：先别往上翻，一两句话就行。明天老师会回应')), explain),
      h('div', { class: 'lh-field' }, h('label', {}, '实际学了多久（分钟）', h('span', { class: 'hint' }, '已按有效学习时间自动填好，可以改')), minutes),
      h('fieldset', { class: 'lh-field' }, h('legend', {}, '难度感受'), scale),
      h('fieldset', { class: 'lh-field' }, h('legend', {}, '哪几段最有帮助', h('span', { class: 'hint' }, '可多选')), chips),
      h('div', { class: 'lh-field' }, h('label', {}, '哪里还没懂', h('span', { class: 'hint' }, '可选')), unclear),
      h('div', { class: 'lh-field' }, h('label', {}, '想对老师说的', h('span', { class: 'hint' }, '可选：形式、节奏、声音都可以说')), note),
      submit, err);
    form.addEventListener('change', () => { err.hidden = true; });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      const difficulty = Number(fd.get('difficulty'));
      if (!difficulty) { err.hidden = false; err.textContent = '选一下难度感受再提交。'; return; }
      const data = {
        minutes: Number(fd.get('minutes')) || 0, difficulty, helpful: fd.getAll('helpful'),
        explain: String(fd.get('explain') || '').slice(0, 2000),
        unclear: String(fd.get('unclear') || '').slice(0, 2000), note: String(fd.get('note') || '').slice(0, 2000),
        ...snapshot(),
      };
      submit.disabled = true;
      if (await post('checkin', data)) {
        store.set('checkin', data);
        store.set('done', new Date().toISOString());
        renderDone(true);
        paint();
      } else {
        err.hidden = false;
        err.textContent = '没保存上：学习记录服务没在运行。双击项目里的 start.cmd，再点一次提交。';
        submit.disabled = false;
      }
    });
    box.replaceChildren(h('h2', {}, '课末打卡'), h('p', { class: 'sub' }, T.labels.checkinSub), form);
  }

  if (READONLY) {
    // 只读：打过卡的照常显示结算（不能修改），没打卡的只放一句说明
    if (store.get('done', null)) { renderDone(); box.querySelector('.lh-done-edit')?.remove(); }
    else box.replaceChildren(h('h2', {}, '课末打卡'), h('p', { class: 'sub' }, '这一页是从回看打开的，只读，不能打卡。'));
    return;
  }
  store.get('done', null) ? renderDone() : renderForm();
}
if (checkinEl) setupCheckin(checkinEl);
else QA.warnings.push('页面没有 <lh-checkin>');

// ---------- 问老师 / 这里没懂 ----------

// 原来还有「想深挖」「周末问」：现在都在「问老师」里问，由老师判断归哪一类
const KINDS = {
  confused: { label: '这里没懂', title: '标记没懂的地方', why: '老师会看到，明天的热身或周末复习会补上。', done: '已标记，老师会看到' },
};
let pop = null;
function closePop() { pop?.remove(); pop = null; }
function openCapture(kind, quote, sec) {
  closePop();
  ask.close();
  closeSleepy();
  recall.close(false);
  const k = KINDS[kind];
  const note = h('textarea', { placeholder: '哪里卡住了？（可选）' });
  const save = async () => {
    const okd = await post('capture', { kind, sec, quote: quote.slice(0, 600), note: note.value.slice(0, 1000) });
    closePop();
    toast(okd ? k.done : '没保存上：学习记录服务没在运行，双击 start.cmd 后再试');
  };
  pop = h('div', { class: 'lh-pop', role: 'dialog', 'aria-label': k.title },
    h('h4', {}, k.title), h('p', { class: 'why' }, k.why),
    quote ? h('blockquote', {}, quote) : sec && h('p', { class: 'why' }, `关于「${sections.find(s => s.id === sec)?.title ?? sec}」这一段`),
    note,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'lh-btn ghost', onclick: closePop }, '取消'),
      h('button', { type: 'button', class: 'lh-btn', onclick: save }, '记下来')));
  document.body.append(pop);
  note.focus();
}
addEventListener('keydown', e => { if (e.key === 'Escape' && !paused) { closePop(); hideFloat(); } });

// 「问老师」当场回答或在后台回答（lh-ask.js）；「这里没懂」只是记下来，交给后面的课和周末
const ask = createAsk({ h, store, sections, current: () => current, qa: QA_MODE, onOpen: () => { closePop(); closeSleepy(); recall.close(false); }, paused: () => !!paused, onUnread: paintUnread, toast });
const capButtons = cb => [
  h('button', { type: 'button', 'data-kind': 'ask', title: '问老师（快捷键 /）', onclick: () => cb('ask') }, '问老师'),
  ...Object.entries(KINDS).map(([kind, k]) => h('button', { type: 'button', 'data-kind': kind, onclick: () => cb(kind) }, k.label)),
];
// 固定的这组最后多「犯困了」和「暂停」；选中文字时浮出的那组没有
const capture = h('div', { class: 'lh-capture', role: 'group', 'aria-label': '提问、记录、犯困了和暂停' },
  capButtons(kind => (kind === 'ask' ? ask.open() : openCapture(kind, '', current?.id ?? null))),
  h('button', { type: 'button', 'data-kind': 'sleepy', title: '犯困了就点这里：给你几件马上能做的小事', onclick: openSleepy }, '犯困了'),
  h('button', { type: 'button', 'data-kind': 'pause', title: '要离开一会儿就点这里：计时停下，回来后点「继续学习」', onclick: pause }, '暂停'));
document.body.append(capture);

// 角标：后台答好了、还没看的回答条数，只加在固定那组的「问老师」上
const askBtn = capture.querySelector('[data-kind=ask]');
const badge = h('span', { class: 'lh-badge', 'aria-hidden': 'true' });
function paintUnread(n) {
  if (n) askBtn.append(badge);
  else badge.remove();
  badge.textContent = n > 9 ? '9+' : String(n);
  askBtn.setAttribute('aria-label', n ? `问老师（${n} 条新回答）` : '问老师');
}
paintUnread(ask.unread);

// 选中正文时，在选区上方浮出「问老师」和「这里没懂」，自动带上选中的文字
let float = null;
function hideFloat() { float?.remove(); float = null; }
document.addEventListener('mouseup', e => {
  if (paused || e.target.closest('.lh-capture, .lh-pop, .lh-ask, .lh-sleepy, input, textarea, button')) return;
  setTimeout(() => {
    const sel = getSelection();
    const text = sel?.toString().trim() ?? '';
    hideFloat();
    if (!text || !sel.rangeCount) return;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const sec = (node.nodeType === 1 ? node : node.parentElement)?.closest('section[data-sec]');
    if (!sec) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    float = h('div', { class: 'lh-capture floating', role: 'group', 'aria-label': '记录选中的内容' },
      capButtons(kind => { hideFloat(); kind === 'ask' ? ask.open(text, sec.dataset.sec) : openCapture(kind, text, sec.dataset.sec); }));
    document.body.append(float);
    const w = float.offsetWidth;
    float.style.left = `${Math.max(8, Math.min(scrollX + r.left + r.width / 2 - w / 2, scrollX + innerWidth - w - 8))}px`;
    float.style.top = `${scrollY + r.top - float.offsetHeight - 8}px`;
  }, 0);
});
document.addEventListener('mousedown', e => { if (float && !float.contains(e.target)) hideFloat(); });

// ---------- 暂停 ----------

// 虚化层盖住整页；后面的元素都设成 inert（点不到、Tab 也到不了），只有「继续学习」能点。
// 「问老师」面板、没写完的弹窗原样留在下面，继续后还在。
const pauseSub = h('p', { class: 'lh-pause-sub' });
const resumeBtn = h('button', { type: 'button', class: 'lh-btn', onclick: resume }, '继续学习');
const pauseEl = h('div', { class: 'lh-pause', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lh-pause-h', hidden: true },
  h('div', { class: 'lh-pause-card' }, h('h2', { id: 'lh-pause-h' }, '学习已暂停'), pauseSub, resumeBtn));
document.body.append(pauseEl);

function pause() {
  if (paused) return;
  recall.close(); // 回看小窗先关上，焦点回到回指处；继续学习后焦点回到那里
  paused = { at: Date.now(), focus: document.activeElement };
  // 配音动画（player.js 的 __LH）和页面、组件里的视频都停下；继续时不自动续播
  for (const f of document.querySelectorAll('.lh-slot iframe')) {
    try {
      f.contentWindow.__LH?.pause();
      for (const m of f.contentDocument.querySelectorAll('video, audio')) m.pause();
    } catch { /* 忽略 */ }
  }
  for (const m of document.querySelectorAll('video, audio')) m.pause();
  hideFloat();
  for (const el of document.body.children) if (el !== pauseEl) el.inert = true;
  pauseSub.textContent = `已学 ${Math.floor(time.total / 60)} 分钟，计时停在这里。`;
  pauseEl.hidden = false;
  document.documentElement.classList.add('lh-paused');
  resumeBtn.focus({ preventScroll: true });
  store.set('time', time);
  log('lesson_pause', { ...snapshot(), sec: current?.id ?? null });
}

function resume() {
  if (!paused) return;
  const { at, focus } = paused;
  paused = null;
  pauseEl.hidden = true;
  document.documentElement.classList.remove('lh-paused');
  for (const el of document.body.children) el.inert = false;
  focus?.focus?.({ preventScroll: true });
  log('lesson_resume', { ...snapshot(), paused_s: Math.round((Date.now() - at) / 1000) });
}

// ---------- 犯困了 ----------

// 提示框里的文字都在这里，改建议只改这一处。tips 每条是 [要做的事, 怎么做]，第二项可以省略
const SLEEPY = {
  title: '犯困了？试试这几件事',
  lead: '一直坐着看和读，犯困很正常。挑一件马上就做：',
  tips: [
    ['站起来活动 2 分钟', '走一圈、洗把脸、喝杯凉水'],
    ['从看换成做', '把刚读的那段用自己的话讲一遍，说出声或者写下来'],
    ['站着读一段'],
  ],
  go: '好，继续学',
  pause: '暂停，起来活动 2 分钟',
};

// 提示框在捕获按钮上方，盖在「问老师」面板和弹窗上面，不关掉它们；打开「问老师」或别的弹窗时它先关掉
const goBtn = h('button', { type: 'button', class: 'lh-btn ghost', onclick: closeSleepy }, SLEEPY.go);
const sleepyEl = h('div', { class: 'lh-sleepy', role: 'dialog', 'aria-labelledby': 'lh-sleepy-h', hidden: true },
  h('h4', { id: 'lh-sleepy-h' }, SLEEPY.title),
  h('p', { class: 'why' }, SLEEPY.lead),
  h('ol', {}, SLEEPY.tips.map(([what, how]) => h('li', {}, h('b', {}, what), how && `：${how}`))),
  h('div', { class: 'row' }, goBtn,
    h('button', { type: 'button', class: 'lh-btn', onclick: () => { closeSleepy(); pause(); } }, SLEEPY.pause)));
document.body.append(sleepyEl);
let sleepyFocus = null; // 打开前的焦点，关掉后还给它

function openSleepy() {
  if (!sleepyEl.hidden) return; // 已经开着：不重复弹，也不重复记
  recall.close(); // 回看小窗先关上，提示框关掉后焦点回到回指处
  sleepyFocus = document.activeElement;
  hideFloat();
  sleepyEl.hidden = false;
  goBtn.focus({ preventScroll: true });
  log('lesson_sleepy', { sec: current?.id ?? null, title: current?.title ?? null, active_s: time.total });
}

function closeSleepy() {
  if (sleepyEl.hidden) return;
  sleepyEl.hidden = true;
  sleepyFocus?.focus?.({ preventScroll: true });
  sleepyFocus = null;
}

// Esc 先只关提示框：在捕获阶段（比「问老师」面板和弹窗的 Esc 处理都早）处理，并且不再往下传
addEventListener('keydown', e => {
  if (e.key === 'Escape' && !sleepyEl.hidden && !paused) { e.stopPropagation(); closeSleepy(); }
}, true);

// ---------- 杂项 ----------

for (const pre of main.querySelectorAll('pre')) {
  pre.append(h('button', { type: 'button', class: 'lh-copy', onclick: async ev => {
    const code = pre.querySelector('code')?.innerText ?? pre.innerText;
    try { await navigator.clipboard.writeText(code); ev.target.textContent = '已复制'; } catch { ev.target.textContent = '复制失败'; }
    setTimeout(() => { ev.target.textContent = '复制'; }, 1500);
  } }, '复制'));
}

if (!document.querySelector('link[rel=icon]')) document.head.append(h('link', { rel: 'icon', href: '/favicon.svg' }));

function banner(msg) { top.after(h('div', { class: 'lh-banner', role: 'alert' }, msg)); }
if (READONLY) banner('这是从回看打开的旧课，只读：不计时，作答和打卡都不会保存。看完关掉这个标签页就行。');
if (location.protocol === 'file:') banner('请双击项目里的 start.cmd 打开课程：直接打开文件时，配音动画、交互和学习记录都无法工作。');
else fetch('/api/health', { cache: 'no-store' }).then(r => { if (!r.ok) throw 0; })
  .catch(() => banner('学习记录服务没在运行，进度和打卡不会保存。双击 start.cmd 后刷新页面。'));

// ---------- 主题装饰 ----------

const api = {
  theme: THEME, main, head, top, toc, route, sections, codex, est, h, store, qa: QA_MODE,
  get current() { return current; },
  seen,
  finished: () => !!store.get('done', null),
  /** 订阅事件：progress（当前段/读过的段变化）、quiz（作答）、checkin（打卡结算渲染，fresh = 刚提交） */
  on(type, fn) {
    (listeners[type] ||= []).push(fn);
    if (last[type]) { try { fn(last[type]); } catch (e) { QA.errors.push(`[主题 ${THEME}] ${type} 回调出错：${e.message}`); } }
  },
};
try { await mod.setup?.(api); } catch (e) { QA.errors.push(`主题 ${THEME} 的 setup 出错：${e.message}`); }
reveal(THEME);

// ---------- 启动 ----------

const slots = [...main.querySelectorAll('lh-media, lh-viz')];
QA.slots.total = slots.length;
await Promise.all(slots.map(s => (s.tagName === 'LH-MEDIA' ? fillMedia(s) : fillViz(s)).catch(e => missing(s, `${s.tagName.toLowerCase()} ${s.id}：${e.message}`))));
renderClock();
updateCurrent();
paint();
// 等字体（最多 2 秒）再宣布就绪，免得 QA 截到回退字体；字体换完重新定位当前段标记
await Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 2000))]);
placeMark();
log('lesson_open', { est, resumed: time.total > 0, active_s: time.total, theme: THEME });
land(main, READONLY);
QA.ready = true;
