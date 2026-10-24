// component.js — 交互组件（viz/*.html）运行时
//
//   <link rel="stylesheet" href="/assets/component.css">   （引导样式；主题的 component.css 由这里按主题加载）
//   <script type="module">
//     import { emit } from '/assets/component.js';
//     emit('viz_try', { value: 3 });   // 记录一次有意义的操作（不要每次拖动都发）
//   </script>
//
// - 嵌在课程页里时：自动把内容高度告诉父页面（iframe 不出现滚动条）；报错、事件、活动心跳都转发给父页面。
// - 单独打开时（自测）：事件直接上报，报错记在 window.__LHC.errors。
// - 组件高度由内容决定：不要给 html/body 设 height:100%；画布类组件给容器写死高度（如 460px）。
// - 颜色和字体用主题的 CSS 变量（token，见 /assets/themes/README.md）。组件自己的脚本在主题样式加载完之后才运行，
//   所以脚本里读到的尺寸和计算样式都是最终的。

import { log } from './lh-log.js';
import { applyTheme } from './lh-theme.js';

const embedded = window.parent !== window;
const QA = (window.__LHC = { errors: [] });
const toParent = msg => { try { parent.postMessage(msg, location.origin); } catch { /* 忽略 */ } };

function report(msg) {
  QA.errors.push(msg);
  console.error(`[LH component] ${msg}`);
  if (embedded) toParent({ lh: 'error', msg });
}
addEventListener('error', e => report(`${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener('unhandledrejection', e => report(`unhandledrejection: ${e.reason}`));

/** 记录一次有意义的交互（如"切换到第 3 种模式""答对了组件里的小挑战"） */
export function emit(type, data = {}) {
  if (embedded) toParent({ lh: 'event', type, data });
  else log(type, { ...data, standalone: true });
}
window.lh = { emit };

await applyTheme('component.css');

// 滑块轨道的已填充部分：把当前值写进 --fill（主题的 component.css 可以用它画进度）。
// 代码里直接改 value 不会触发 input 事件，所以点击/按键之后也同步一次。
function syncRanges() {
  for (const r of document.querySelectorAll('input[type=range]')) {
    const min = Number(r.min) || 0, max = Number(r.max) || 100;
    r.style.setProperty('--fill', `${((Number(r.value) - min) / (max - min || 1)) * 100}%`);
  }
}
for (const ev of ['input', 'change', 'click', 'keyup']) addEventListener(ev, () => requestAnimationFrame(syncRanges), { passive: true });
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', syncRanges); else syncRanges();
addEventListener('load', syncRanges);

if (embedded) {
  let last = 0;
  const sendHeight = () => {
    const hgt = Math.ceil(document.body.getBoundingClientRect().height);
    if (Math.abs(hgt - last) > 1) { last = hgt; toParent({ lh: 'height', h: hgt }); }
  };
  new ResizeObserver(sendHeight).observe(document.body);
  addEventListener('load', sendHeight);

  // 组件里的操作不会冒泡到父页面，靠心跳让父页面知道"还在学"
  let lastPing = 0;
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'input']) {
    addEventListener(ev, () => {
      const now = Date.now();
      if (now - lastPing > 5000) { lastPing = now; toParent({ lh: 'activity' }); }
    }, { passive: true });
  }
}
