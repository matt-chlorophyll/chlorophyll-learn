// theme.js — 主题 anatomy「图谱」的选项和装饰（接口见 ../README.md）
//
// 装饰：
// - 侧边今日路线的当前段标记：一块小等轴测方块（放进 .lh-toc-mark，位置由运行时的 --mark-y/--mark-h 决定）
// - 页头零件条：每段一块板，长度 ∝ 分钟数；读过的压暗，正在读的升起并描成墨色，Stretch 段顶面斜纹
// - 打卡结算的徽记：底板上立着一块方块，顶面刻一个 ✓
// 全部是 aria-hidden 的装饰，不改文字。

import { camera, solid, ns, defs, line } from './iso.js';

export const options = {
  number: n => String(n).padStart(2, '0'),
};

const CUBE = '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M8 1.5 14 4.8 8 8.1 2 4.8Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>'
  + '<path d="M2 4.8 8 8.1V14.6L2 11.3Z" fill="#F6F6F3" stroke="#000" stroke-width="1" stroke-linejoin="round"/>'
  + '<path d="M14 4.8 8 8.1V14.6L14 11.3Z" fill="#E6E6E3" stroke="#000" stroke-width="1" stroke-linejoin="round"/></svg>';

function drawStrip(svg, sections, est, cur, seen, finished) {
  svg.replaceChildren();
  defs(svg);
  const W = 640, Lw = 560, gap = 7, D = 28;
  const unit = (Lw - gap * (sections.length - 1)) / Math.max(1, est);
  const cam = camera({ az: 6, el: 42 });
  const H = cam.fitWidth([[0, 0, -2], [Lw, 0, -2], [Lw, D, -2], [0, D, 16]], W, 4);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let x = 0;
  const segs = sections.map(s => { const seg = { s, x, len: Math.max(unit * s.min, 4) }; x += seg.len + gap; return seg; });
  for (const seg of [...segs].reverse()) {                // x 大的更靠后，先画
    const now = seg.s === cur, done = seen.has(seg.s.id) && (!now || finished);
    const z = now ? 14 : 6;
    const b = solid(svg, { tone: now ? 'hi' : done ? 'ink' : '' }).set(seg.x, 3, 0, seg.len, D - 6, z, cam);
    if (now) b.lit(true);
    if (seg.s.stretch) {
      for (let t = 4; t < seg.len; t += 4) ns(svg, 'path', { class: 'hatch', d: line([cam.P(seg.x + t, 3, z), cam.P(seg.x + Math.max(0, t - 6), D - 3, z)]) });
    }
  }
}

function drawEmblem(box) {
  const svg = ns(null, 'svg', { viewBox: '0 0 76 64', 'aria-hidden': 'true' });
  defs(svg);
  const cam = camera({ az: 30, el: 32, scale: 1 });
  const [cx, cy] = cam.P(20, 20, 0);
  cam.ox = 38 - cx; cam.oy = 46 - cy;
  solid(svg, { tone: 'mid' }).set(-4, -4, -5, 48, 48, 5, cam);                 // 底板
  const rise = ns(svg, 'g', { class: 'rise' });
  solid(rise, { tone: 'hi' }).set(6, 6, 0, 28, 28, 20, cam).lit(true);         // 方块
  // 顶面刻一个 ✓（按等轴测投影画在顶面上）
  ns(rise, 'path', { class: 'tick', d: line([cam.P(12, 21, 20), cam.P(18, 15, 20), cam.P(29, 27, 20)]),
    fill: 'none', stroke: 'var(--climb)', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  // 四个螺丝
  for (const [x, y] of [[-1, -1], [41, -1], [41, 41], [-1, 41]]) { const [sx, sy] = cam.P(x, y, 0); ns(svg, 'circle', { cx: sx, cy: sy, r: 0.9, fill: 'var(--iso-mid)' }); }
  box.replaceChildren(svg);
}

export function setup(api) {
  // 侧边路线的当前段标记
  const mark = api.toc.querySelector('.lh-toc-mark');
  if (mark) mark.innerHTML = CUBE;

  // 页头零件条：放在路线概览里（运行时的等比例条由 CSS 隐藏），总计那一行留在下面
  const strip = api.h('div', { class: 'lh-strip', 'aria-hidden': 'true' });
  const svg = ns(strip, 'svg', { 'aria-hidden': 'true' });
  const total = api.route.querySelector('.lh-route-total');
  api.route.insertBefore(strip, total);
  drawStrip(svg, api.sections, api.est, api.current, api.seen, api.finished());
  api.on('progress', ({ current, seen, finished }) => drawStrip(svg, api.sections, api.est, current, seen, finished));

  // 打卡结算徽记（刚提交时 .lh-reward.celebrate 让方块升起、✓ 描出来；QA 和减少动效时直接到终点）
  api.on('checkin', ({ emblem }) => drawEmblem(emblem));
}

