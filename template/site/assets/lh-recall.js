// lh-recall.js — 回指回看：课文提到之前学过的题、讲解、你的留言时，点开小窗看当时的原文
//
// 课件写法（规则和快照格式见 platform/style-guide.md「回指回看」）：
//   正文里：<lh-recall ref="w00/d0#q4">Day 0 诊断第 4 题</lh-recall>
//   快照：  <template data-recall="w00/d0#q4" data-kind="quiz" data-label="…" data-was="a">原文元素的原样拷贝</template>
//           放在 <lh-checkin> 后面，每个 ref 一份；同一个 ref 可以被正文引用多次
// 小窗只显示生成课件时存的快照，不去旧课现取：旧课后来改了、换了浏览器，看到的都是当时那一版。
//   quiz：先只显示题干和选项（点不动），点「看答案」才显示正确答案、你当时的作答和解析
//   text：直接显示那段讲解（段落、代码块、表格……）
//   note：直接显示你当时写的话（打卡、「这里没懂」、问老师）
//   media / viz：不嵌入组件，只放一句说明和「去原文」
// 「去原文」在新标签页打开旧课（?from=recall#锚点）：那一页只读、不计时（lesson.js 的 READONLY），并停在锚点上（land）。
// 每次点开记一条 recall_open（ref、kind、所在段）。

const REF = /^w(\d{2})\/d(\d+)#([\w-]+)(?:~\d+)?$/;
const KIND_LABEL = { quiz: '题目', text: '讲解', note: '你的留言', media: '配音动画', viz: '交互组件' };
const SELF = { got: '想对了', partial: '想到一部分', missed: '没想到' };

// 当前页 /lessons/<topic>/wNN/dN/ → 课程根 /lessons/<topic>/ 和 [周, 天]
function here(page) {
  const m = page.match(/^(\/lessons\/[^/]+\/)w(\d{2})\/d(\d+)\//);
  return m ? { base: m[1], w: Number(m[2]), d: Number(m[3]) } : { base: '/', w: null, d: null }; // lab 样例页等：不检查先后
}

// 快照里嵌套的回指（被引用的原文自己也引用了更早的课）：小窗里点不开，显示成普通文字
function flat(root) {
  for (const x of root.querySelectorAll('lh-recall')) x.replaceWith(...x.childNodes);
  return root;
}

export function parseRef(ref) {
  const m = String(ref || '').trim().match(REF);
  return m && { w: Number(m[1]), d: Number(m[2]), anchor: m[3], path: `w${m[1]}/d${m[2]}/` };
}

// 你当时的作答：先看快照（生成时从学习记录里取的），再看原页面在这个浏览器里存的；都没有就是 null
function wasOf(snap, targetPage, id) {
  const w = snap.dataset.was;
  if (w) return { v: w.toLowerCase(), note: snap.dataset.wasNote || '', from: 'snapshot' };
  try {
    const pages = [targetPage, `${targetPage}index.html`];
    for (const p of pages) {
      const v = JSON.parse(localStorage.getItem(`lh:${p}:quiz:${id}`) || 'null');
      if (v?.choice) return { v: String(v.choice).toLowerCase(), from: 'storage' };
      if (v?.self) return { v: v.self, note: v.note || '', from: 'storage' };
    }
    // 那节课打过卡、这道题却没有作答记录：能确认是当时跳过了
    for (const p of pages) if (localStorage.getItem(`lh:${p}:done`)) return { v: 'skip', from: 'storage' };
  } catch { /* 隐私模式等 */ }
  return null;
}

/**
 * @param {object} o
 * @param {Function} o.h        lesson.js 的建元素函数
 * @param {Element}  o.main     main.lesson
 * @param {string}   o.page     当前页路径（location.pathname）
 * @param {Function} o.log      记事件
 * @param {Function} o.warn     QA 警告
 * @param {Function} o.paused   页面是否暂停中（暂停时不响应）
 * @param {Function} o.onOpen   打开小窗前调用（关掉「这里没懂」弹窗、犯困了提示框）
 */
export function createRecall({ h, main, page, log, warn, paused, onOpen }) {
  const me = here(page);
  const snaps = new Map();
  for (const t of main.querySelectorAll('template[data-recall]')) {
    const ref = t.dataset.recall;
    if (snaps.has(ref)) warn(`回看快照重复：${ref}`);
    if (!parseRef(ref)) warn(`回看快照的 ref 写法不对：${ref}（应为 wNN/dN#锚点）`);
    if (!KIND_LABEL[t.dataset.kind]) warn(`回看快照 ${ref} 的 data-kind 不对：${t.dataset.kind}`);
    snaps.set(ref, t);
  }
  const triggers = [...main.querySelectorAll('lh-recall')];
  const used = new Set();
  for (const el of triggers) {
    const ref = el.getAttribute('ref');
    const r = parseRef(ref);
    const snap = snaps.get(ref);
    if (!r) warn(`回指 ref 写法不对：${ref}（应为 wNN/dN#锚点）`);
    else if (me.w != null && (r.w > me.w || (r.w === me.w && r.d >= me.d))) warn(`回指只能指向之前学过的课：${ref}`);
    if (!snap) { warn(`回指 ${ref} 没有对应的快照 <template data-recall>`); continue; }
    used.add(ref);
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('aria-expanded', 'false');
    el.title = `回看：${snap.dataset.label || ref}`;
    el.addEventListener('click', e => { e.preventDefault(); toggle(el); });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(el); }
    });
  }
  for (const ref of snaps.keys()) if (!used.has(ref)) warn(`回看快照 ${ref} 没有被正文引用`);

  let cur = null; // { el, pop }

  function toggle(el) {
    if (paused?.()) return;
    if (cur?.el === el) close();
    else open(el);
  }

  function hrefOf(r) {
    return `${me.base}${r.path}?from=recall#${r.anchor}`;
  }

  // ---------- 小窗内容 ----------

  function quizBody(snap, r, targetPage) {
    const q = snap.content.querySelector('lh-quiz');
    if (!q) return [h('p', { class: 'lh-recall-note' }, '快照里没有题目。')];
    const reveal = q.getAttribute('type') === 'reveal';
    const answer = (q.getAttribute('answer') || '').trim().toLowerCase();
    const list = reveal ? null : q.querySelector(':scope > ul, :scope > ol');
    const why = q.querySelector(':scope > .why');
    const stem = h('div', { class: 'lh-recall-stem' });
    for (const n of q.childNodes) if (n !== list && n !== why) stem.append(n.cloneNode(true));
    const was = wasOf(snap, targetPage, q.id || r.anchor);
    const items = list ? [...list.children].map((li, i) => {
      const k = (li.dataset.k || String.fromCharCode(97 + i)).toLowerCase();
      return h('li', { 'data-k': k }, h('span', { class: 'k' }, k.toUpperCase()), h('span', { class: 't', html: li.innerHTML }));
    }) : [];
    const opts = items.length ? h('ul', { class: 'lh-recall-opts', 'aria-label': '选项（只读）' }, items) : null;
    const hint = h('p', { class: 'lh-recall-hint' }, '先在心里答一遍，再看答案。');
    const result = h('div', { class: 'lh-recall-result', hidden: true });
    const btn = h('button', { type: 'button', class: 'lh-btn ghost lh-recall-reveal' }, '看答案');
    btn.addEventListener('click', () => {
      for (const li of items) {
        const k = li.dataset.k;
        if (k === answer) { li.classList.add('right'); li.append(h('span', { class: 'tag' }, '正确答案')); }
        if (was && k === was.v) { li.classList.add('was'); li.append(h('span', { class: 'tag' }, '你当时选的')); }
      }
      result.append(h('p', { class: 'lh-recall-was' }, wasLine(was, reveal, answer)));
      if (was?.note) result.append(h('blockquote', {}, `你当时写的：${was.note}`));
      if (why) {
        const w = flat(why.cloneNode(true));
        w.className = 'lh-recall-why';
        w.removeAttribute('hidden');
        result.append(w);
      }
      result.hidden = false;
      hint.remove();
      btn.parentElement.remove();
      if (cur) place(cur.pop, cur.el);
      cur?.pop.focus({ preventScroll: true });
    });
    return [stem, opts, hint, h('div', { class: 'lh-recall-revealrow' }, btn), result];
  }

  function wasLine(was, reveal, answer) {
    if (!was) return '没找到当时的作答。';
    if (was.v === 'skip') return '当时跳过了。';
    if (reveal) return `你当时的自评：${SELF[was.v] ?? was.v}。`;
    if (was.v === answer) return `你当时选了 ${was.v.toUpperCase()}，答对了。`;
    return was.v === 'x' ? '你当时选了「还不确定」。' : `你当时选了 ${was.v.toUpperCase()}。`;
  }

  function copyBody(snap) {
    const box = h('div', { class: 'lh-recall-copy' });
    box.append(snap.content.cloneNode(true));
    for (const x of box.querySelectorAll('[id]')) x.removeAttribute('id'); // 原文的 id 不带进当前页
    for (const t of box.querySelectorAll('table')) {
      const wrap = h('div', { class: 'lh-recall-scroll' });
      t.replaceWith(wrap);
      wrap.append(t);
    }
    return [box];
  }

  function noteBody(snap) {
    const at = snap.dataset.at ? snap.dataset.at.slice(0, 16).replace('T', ' ') : '';
    const src = { checkin: '课末打卡', capture: '「这里没懂」', ask: '「问老师」' }[snap.dataset.src] ?? '';
    const box = h('div', { class: 'lh-recall-copy lh-recall-quote' });
    box.append(snap.content.cloneNode(true));
    return [h('p', { class: 'lh-recall-meta' }, [src && `你在${src}里写的`, at].filter(Boolean).join('，')), box];
  }

  function embedBody(snap, kind) {
    const slot = snap.content.querySelector('lh-media, lh-viz');
    const title = slot?.getAttribute('title') || '';
    const what = kind === 'media' ? '配音动画' : '交互组件';
    return [h('p', { class: 'lh-recall-note' }, `这里指向${what}${title ? `「${title}」` : ''}。小窗里不放${what}，点「去原文」在旧课里看。`)];
  }

  function open(el) {
    const ref = el.getAttribute('ref');
    const snap = snaps.get(ref);
    const r = parseRef(ref);
    if (!snap || !r) return;
    close(false);
    onOpen?.();
    const kind = snap.dataset.kind;
    const targetPage = `${me.base}${r.path}`;
    const body = kind === 'quiz' ? quizBody(snap, r, targetPage)
      : kind === 'note' ? noteBody(snap)
      : kind === 'media' || kind === 'viz' ? embedBody(snap, kind)
      : copyBody(snap);
    const label = snap.dataset.label || ref;
    const pop = h('div', { class: `lh-recall-pop kind-${kind}`, role: 'dialog', 'aria-label': `回看：${label}`, tabindex: '-1' },
      h('div', { class: 'lh-recall-h' },
        h('p', {}, h('span', { class: 'kind' }, `回看 · ${KIND_LABEL[kind] ?? kind}`), h('span', { class: 'where' }, label)),
        h('button', { type: 'button', class: 'lh-recall-x', 'aria-label': '关闭回看', title: '关闭（Esc）', onclick: () => close() }, '×')),
      h('div', { class: 'lh-recall-body' }, body),
      h('div', { class: 'lh-recall-f' },
        h('a', { class: 'lh-recall-go', href: hrefOf(r), target: '_blank', rel: 'noopener' }, '去原文 ↗')));
    flat(pop);
    document.body.append(pop);
    cur = { el, pop };
    el.setAttribute('aria-expanded', 'true');
    el.classList.add('is-open');
    place(pop, el);
    pop.focus({ preventScroll: true });
    log('recall_open', { ref, kind, sec: el.closest('section[data-sec]')?.dataset.sec ?? null });
  }

  // 关掉小窗；restore：焦点回到原来的回指处
  function close(restore = true) {
    if (!cur) return;
    const { el, pop } = cur;
    cur = null;
    pop.remove();
    el.setAttribute('aria-expanded', 'false');
    el.classList.remove('is-open');
    if (restore) el.focus({ preventScroll: true });
  }

  // 小窗放在回指的下方，放不下就放上方，再放不下就在屏幕内尽量靠下（会盖住回指）；
  // 上面不压顶部条，下面留出捕获按钮，左右不出屏；跟着页面滚动
  // 代码块、表格比小窗宽（常见于行末注释）时，小窗放宽到放得下为止，最多 760px；
  // 还放不下（窄屏）就在框里横向滚动，右边缘的阴影提示右边还有
  function place(pop, el) {
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    const r = el.getClientRects()[0] || el.getBoundingClientRect();
    const top = Math.max(0, document.querySelector('.lh-top')?.getBoundingClientRect().bottom ?? 0) + 12;
    const bottom = vh - 84;
    const cap = Math.min(760, vw - 24);
    const boxes = [...pop.querySelectorAll('pre, .lh-recall-scroll')];   // 代码框、表格的滚动框
    let w = Math.min(540, cap);
    const fit = () => {
      const over = Math.max(0, ...boxes.map(p => p.scrollWidth - p.clientWidth));
      if (over > 0 && w < cap) { w = Math.min(w + over + 2, cap); pop.style.width = `${w}px`; }
    };
    pop.style.width = `${w}px`;
    pop.style.maxHeight = '';
    fit();
    const avail = Math.max(220, bottom - top);
    pop.style.maxHeight = `${avail}px`;
    fit(); // 高度封顶后出现竖向滚动条，框又窄了一截
    for (const p of boxes) scrollHint(p);
    const ph = Math.min(pop.scrollHeight, avail);
    const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, vw - w - 12));
    const y = r.bottom + 10 + ph <= bottom ? r.bottom + 10
      : r.top - 10 - ph >= top ? r.top - 10 - ph
      : Math.max(top, bottom - ph);
    pop.style.left = `${scrollX + left}px`;
    pop.style.top = `${scrollY + y}px`;
  }

  // 代码框、表格右边还有没露出来的内容时加 .lh-more（右边缘的阴影），滚到头就去掉
  const hinted = new WeakSet();
  function scrollHint(p) {
    const upd = () => p.classList.toggle('lh-more', p.scrollLeft + p.clientWidth < p.scrollWidth - 1);
    if (!hinted.has(p)) { hinted.add(p); p.addEventListener('scroll', upd, { passive: true }); }
    upd();
  }

  // 点外面关掉（焦点回到回指处）；点到别的按钮（暂停、犯困了……）时也是先关小窗，那个按钮照常响应
  // 点在不能聚焦的地方（正文、空白）时，浏览器会把焦点放回 body：松手后再把焦点还给回指处
  document.addEventListener('pointerdown', e => {
    if (!cur || cur.pop.contains(e.target) || cur.el.contains(e.target)) return;
    const { el } = cur;
    close();
    addEventListener('pointerup', () => setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement) el.focus({ preventScroll: true });
    }, 0), { once: true });
  }, true);
  // Esc 只关小窗：在捕获阶段处理并且不再往下传，下面的「问老师」面板保持打开
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && cur && !paused?.()) { e.stopPropagation(); close(); }
  }, true);
  addEventListener('resize', () => { if (cur) place(cur.pop, cur.el); });

  return { close, get isOpen() { return !!cur; }, count: triggers.length, snapshots: snaps.size };
}

// 从「去原文」打开的旧课：停在锚点上并短暂标出。锚点可以是元素 id、段落的 data-sec、组件插槽的 id 或 checkin
export function land(main, highlight) {
  const a = decodeURIComponent(location.hash.slice(1));
  if (!a) return;
  const css = s => (window.CSS?.escape ? CSS.escape(s) : s);
  const t = document.getElementById(a) || main.querySelector(`[data-sec="${css(a)}"]`)
    || main.querySelector(`.lh-slot[data-id="${css(a)}"]`) || (a === 'checkin' ? main.querySelector('lh-checkin') : null);
  if (!t) return;
  let moved = false;
  const stop = () => { moved = true; };
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(ev, stop, { once: true, passive: true });
  // 短的放在屏幕中间；高的顶端对齐到顶部条和横幅下面
  const go = () => {
    if (moved) return;
    const bar = Math.max(0, ...[...document.querySelectorAll('.lh-top, .lh-banner')].map(x => x.getBoundingClientRect().bottom)) + 16;
    const r = t.getBoundingClientRect();
    const y = r.height > innerHeight - bar - 40 ? r.top - bar : r.top + r.height / 2 - (bar + innerHeight) / 2;
    scrollTo({ top: scrollY + y, behavior: 'instant' });
  };
  go();
  // 交互组件加载完会改高度，前面的内容一变，位置就偏了：再对两次（学习者自己滚过就不动）
  setTimeout(go, 700);
  setTimeout(go, 1600);
  if (highlight) {
    t.classList.add('lh-recall-target');
    setTimeout(() => t.classList.remove('lh-recall-target'), 4000);
  }
}
