// lh-ask.js — 课程页的「问老师」面板（lesson.js 加载，所有主题共用；外观在各主题的 lesson.css 里）
//
// 打开方式：捕获按钮里的「问老师」、选中正文后浮出的「问老师」（带上选中的文字）、键盘 /
// 问题连同正在读的那一段、这节课之前的问答，一起发给本地服务器的 /api/ask（tools/ask.mjs），回答边生成边显示。
// 「发送，稍后看」：问题照样发出去，面板马上收起；老师在后台回答，面板关着时答好的条数显示在「问老师」按钮的角标上（onUnread）。
// 点了「发送」、回答还在生成时，这个按钮变成「稍后看」：这条回答转到后台接着答，面板收起，「发送」按钮空出来。
// 每条回答下面写明老师的归类：当场讲完、已存进想深挖、已存进周末问（规则在 platform/ask-teacher.md）。
// 做题时老师只给提示，最新一条提示下面有「我试过了，看答案」。
// 本节课的问答存在 localStorage，刷新后还在。问题发出前就存好：回答还没收到就刷新或关掉了页面的，回来后显示"回答没收到"和「重问」。

const PARK = /⟦[^⟧]*(⟧|$)/g; // 老师用来标记"想深挖""周末问""只给了提示"等的那一行，不显示给学习者
const REVEAL_Q = '我试过了，直接告诉我答案吧。';

// 「稍后看」按钮的两种样子：[文字, 鼠标悬停时的说明]。busy：当场回答进行中
const LATER = {
  idle: ['发送，稍后看', '问题照样发给老师，面板收起，你接着学；答好了「问老师」上会出现角标'],
  busy: ['稍后看', '这条回答转到后台接着答，面板收起，你接着学；答好了「问老师」上会出现角标'],
};

// 归类结果（tools/ask.mjs 返回的 cat）：[粗体部分, 后面的说明]
const CAT = {
  now: () => ['当场讲完', ''],
  dig: tag => ['已存进想深挖', `：${tag}，讲到相关内容时会带你回来`],
  weekend: () => ['已存进周末问', '：留到周末练习时一起讲'],
};

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

// 只认老师会用到的几种写法：段落、**粗体**、`代码`、代码块、列表
function md(src) {
  const out = [];
  src.split(/```[^\n]*\n?/).forEach((part, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`); return; }
    let list = null, para = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map(x => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; };
    for (const line of part.split('\n')) {
      const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)、]\s*(.*)/);
      const item = ul || ol;
      if (!line.trim()) { flushPara(); flushList(); }
      else if (item) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (list?.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(item[1]);
      } else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
  });
  return out.join('');
}

const isTyping = el => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/**
 * @param {object} o
 * @param {Function} o.h          lesson.js 的建元素函数
 * @param {object}   o.store      本页的 localStorage
 * @param {Array}    o.sections   { el, id, title, index }
 * @param {Function} o.current    返回正在读的段落
 * @param {boolean}  o.qa         QA 模式：问答不记进学习记录
 * @param {Function} o.onOpen     打开面板前调用（关掉别的弹窗）
 * @param {Function} o.paused     返回页面是否暂停中：暂停时打开面板和键盘（/、Esc）都不响应，面板保持原样；后台的回答照常回来
 * @param {Function} o.onUnread   未读回答的条数变了：n（面板关着时答好的，打开面板就清零）
 * @param {Function} o.toast      页面底部的短提示
 */
export function createAsk({ h, store, sections, current, qa, onOpen, paused, onUnread, toast }) {
  let history = store.get('ask', []);
  let quote = '', quoteSec = null, busy = null; // busy：正在当场回答的那条 { item, ctrl }，这时「发送」按钮变成「停止」
  let leaving = false; // 页面正在刷新或关掉：这时断开的请求不算出错，下次打开显示"回答没收到"
  addEventListener('pagehide', () => { leaving = true; });
  addEventListener('pageshow', () => { leaving = false; });

  const ctx = h('p', { class: 'lh-ask-ctx' });
  const log = h('div', { class: 'lh-ask-log', 'aria-live': 'polite' });
  const quoteText = h('span', {});
  const quoteBox = h('div', { class: 'lh-ask-quote', hidden: true }, quoteText,
    h('button', { type: 'button', 'aria-label': '不带选中的文字', title: '不带选中的文字', onclick: () => setQuote('', null) }, '×'));
  const input = h('textarea', { rows: 2, placeholder: '问点什么……', 'aria-label': '你的问题' });
  const sendBtn = h('button', { type: 'submit', class: 'lh-btn' }, '发送');
  const laterBtn = h('button', { type: 'button', class: 'lh-btn ghost later', title: LATER.idle[1], onclick: () => (busy ? toLater() : sendLater()) }, LATER.idle[0]);
  const clearBtn = h('button', { type: 'button', class: 'lh-btn ghost', onclick: clear }, '清空');
  const form = h('form', { class: 'lh-ask-f' }, quoteBox, input,
    h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Enter 发送，Shift+Enter 换行'), clearBtn, laterBtn, sendBtn));
  const panel = h('aside', { class: 'lh-ask', role: 'dialog', 'aria-label': '问老师', hidden: true },
    h('div', { class: 'lh-ask-h' }, h('h4', {}, '问老师'), ctx,
      h('button', { type: 'button', class: 'lh-ask-x', 'aria-label': '关闭', title: '关闭（Esc）', onclick: close }, '×')),
    log, form);
  document.body.append(panel);

  const secOf = id => sections.find(s => s.id === id) ?? null;
  const target = () => secOf(quoteSec) ?? current();

  function context() {
    const s = target();
    ctx.textContent = s ? `关于第 ${s.index + 1} 段「${s.title}」` : '关于这节课';
  }

  function setQuote(text, sec) {
    quote = text;
    quoteSec = text ? sec : null;
    quoteText.textContent = text;
    quoteBox.hidden = !text;
    context();
  }

  function itemEl(t) {
    const a = h('div', { class: `lh-ask-a${t.err ? ' is-error' : ''}${t.pending ? ' is-pending' : ''}` });
    const shown = t.a.replace(PARK, '').trim();
    a.innerHTML = md(shown);
    if (t.err) a.append(h('p', { class: 'err' }, t.err));
    // 出错或没收到的，原样再问一次；当场问的那种，要等正在回答的那条答完
    if (t.err) {
      a.append(h('p', { class: 'lh-ask-retry' },
        h('button', { type: 'button', class: 'lh-btn ghost', disabled: !t.later && !!busy, onclick: () => retry(t) }, '重问')));
    }
    // 看答案要接着这条提示问，所以只有最新一条有按钮
    if (t.hint && t === history.at(-1) && !busy) {
      a.append(h('p', { class: 'lh-ask-hint' }, h('span', {}, '这是提示，先自己试试。'),
        h('button', { type: 'button', class: 'lh-btn ghost', onclick: () => send(REVEAL_Q) }, '我试过了，看答案')));
    }
    // 归类结果：答完的每一条都有。parked 是改版前存下的问答（那时只有想深挖一种标记）
    if (!t.err && !t.pending) {
      const cat = t.cat ?? (t.parked ? 'dig' : 'now');
      const [b, rest] = (CAT[cat] ?? CAT.now)(t.tag ?? t.parked);
      a.append(h('p', { class: 'lh-ask-cat', 'data-cat': cat }, h('b', {}, b), rest));
    }
    return h('div', { class: 'lh-ask-turn' },
      h('div', { class: 'lh-ask-q' }, t.quote && h('blockquote', {}, t.quote), h('p', {}, t.q)), a);
  }

  function render() {
    log.replaceChildren(...(history.length ? history.map(itemEl)
      : [h('p', { class: 'lh-ask-empty' }, '读到哪里卡住了就问，老师知道你正在读哪一段。还没学到的，老师先给个直觉，存进想深挖；要动手练的，存进周末问。不想等回答，就点「发送，稍后看」接着学；已经点了「发送」的，也可以点「稍后看」。答好了「问老师」上会出现角标。做题时老师只给提示，试过之后可以再要答案。')]));
    log.scrollTop = log.scrollHeight;
  }

  let raf = 0;
  const renderSoon = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); };
  const save = () => store.set('ask', history.slice(-30));
  const unread = () => history.filter(t => t.unread).length;

  // 上次离开页面时还没收到的回答：服务器照常答完、记进了学习记录，但这个页面收不到了
  const lost = history.filter(t => t.pending);
  for (const t of lost) {
    delete t.pending;
    t.err = '回答没收到：老师答好之前，页面刷新或关掉了。';
    t.unread = true;
  }
  if (lost.length) save();

  function paintBusy() {
    sendBtn.textContent = busy ? '停止' : '发送';
    sendBtn.classList.toggle('stop', !!busy);
    [laterBtn.textContent, laterBtn.title] = busy ? LATER.busy : LATER.idle;
    clearBtn.disabled = history.some(t => t.pending);
  }

  function clear() {
    if (history.some(t => t.pending)) return;
    history = [];
    save();
    render();
    input.focus();
  }

  // text：按钮代发的问题（不动输入框里正在写的内容）；不传就发输入框里的
  function send(text) {
    const q = (text ?? input.value).trim();
    if (!q) return;
    if (text == null) input.value = '';
    ask(q, { quote, sec: target()?.id ?? null });
    setQuote('', null);
  }

  // 发送，稍后看：问题照样发给老师，面板马上收起，接着学
  function sendLater() {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    input.value = '';
    ask(q, { later: true, quote, sec: target()?.id ?? null });
    setQuote('', null);
    close();
    toast?.('已发给老师，接着学吧。答好了，「问老师」上会出现角标。');
  }

  // 稍后看：正在当场回答的这条转到后台接着答（连接不断，回答照常收进这一条），「发送」按钮空出来，面板收起。
  // 再告诉服务器这条记成稍后看（学习记录里的 later）
  function toLater() {
    const { item } = busy;
    item.later = true;
    busy = null;
    save();
    fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ later: item.id }) }).catch(() => {});
    paintBusy();
    close();
    toast?.('老师在后台接着答，你接着学吧。答好了，「问老师」上会出现角标。');
  }

  // 重问：去掉出错的那条，用同样的问题、选中的文字和段落再问一次
  function retry(t) {
    history.splice(history.indexOf(t), 1);
    ask(t.q, { later: !!t.later, quote: t.quote, sec: t.sec });
  }

  // 停止：告诉服务器停掉这个回答（只断开连接的话，服务器会当成离开了页面，照常答完）
  function stop() {
    fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stop: busy.item.id }) }).catch(() => {});
    busy.ctrl.abort();
  }

  // 发出一个问题。later：发送，稍后看，在后台回答，不占「发送」按钮
  async function ask(q, { later = false, quote = '', sec = null } = {}) {
    const s = secOf(sec);
    const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, q, quote, sec: s?.id ?? null, a: '', at: new Date().toISOString(), pending: true };
    if (later) item.later = true;
    // 之前的问答由页面每次带上：模型不记得上一次调用
    const prior = history.filter(t => t.a && !t.err && !t.pending).slice(-6)
      .map(t => ({ q: t.quote ? `（关于选中的「${t.quote.slice(0, 80)}」）${t.q}` : t.q, a: t.a.replace(PARK, '').trim() }));
    history.push(item);
    save(); // 先存问题：回答回来之前刷新或关掉页面，问题也还在
    const ctrl = new AbortController();
    if (!later) busy = { item, ctrl };
    paintBusy();
    render();
    const body = {
      id: item.id, later, page: location.pathname, lesson: document.querySelector('h1')?.textContent.trim() ?? '', question: q, quote, history: prior, qa,
      section: s && { id: s.id, n: s.index + 1, title: s.title, text: s.el.innerText.slice(0, 4000) },
    };
    let ended = false;
    try {
      const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `服务器返回 ${r.status}`);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const m = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (m.t === 'd') { item.a += m.x; if (!panel.hidden) renderSoon(); }
          else if (m.t === 'end') { ended = true; item.cat = m.cat; if (m.tag) item.tag = m.tag; item.hint = !!m.hint; }
          else if (m.t === 'err') { ended = true; item.err = m.msg; }
        }
      }
      if (!ended) item.err = '回答中断了，再问一次试试。';
    } catch (e) {
      if (leaving) return; // 保持"还在等"的状态存着，下次打开页面显示"回答没收到"
      if (e.name === 'AbortError') item.err = '已停止。';
      else if (e instanceof TypeError) item.err = '连不上学习服务器：双击 start.cmd 启动后再问。';
      else item.err = e.message;
    }
    delete item.pending;
    if (panel.hidden) item.unread = true; // 面板关着时答好的：打开面板才算看到
    if (busy?.item === item) busy = null;
    save();
    paintBusy();
    render();
    onUnread?.(unread());
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (busy) stop();
    else send();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });

  function open(text = '', sec = null) {
    if (paused?.()) return;
    onOpen?.();
    if (text) setQuote(text.slice(0, 1200), sec);
    context();
    panel.hidden = false;
    document.documentElement.classList.add('lh-asking');
    // 打开面板就算看到了：未读的都标成已读，角标消失
    if (unread()) {
      for (const t of history) delete t.unread;
      save();
      onUnread?.(0);
    }
    render();
    input.focus();
  }
  function close() {
    panel.hidden = true;
    document.documentElement.classList.remove('lh-asking');
  }

  addEventListener('keydown', e => {
    if (paused?.()) return;
    if (e.key === 'Escape' && !panel.hidden) close();
    else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) { e.preventDefault(); open(); }
  });

  return { open, close, context, el: panel, get isOpen() { return !panel.hidden; }, get unread() { return unread(); } };
}
