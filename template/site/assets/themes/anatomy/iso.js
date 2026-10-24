// iso.js — 等轴测零件小工具（交互组件、配音动画、课程页路线条共用）
//
// 画法规则见 DESIGN.md「等轴测零件」：浅色单色、四色调明暗、从后往前画、每个零件都立在另一个零件上。
// 思路参考 Anatomy skill（github.com/wheresryan22/anatomy，MIT）的 kit：相机方位角/仰角、按朝向分色调的实体。
// 代码为本项目自写，没有拷贝它的实现。
//
//   import { camera, solid, cyl, ball, ns } from '../assets/iso.js';
//   const cam = camera({ az: 25, el: 30, scale: 1.2, ox: 40, oy: 300 });
//   const b = solid(svgGroup);            // 一个长方体：顶面 + 左侧面 + 正面
//   b.set(x, y, z, dx, dy, dz, cam);      // 世界坐标：x、y 在地面上，z 向上；单位约等于 1px
//   b.lit(true);                          // 当前要看的零件：描边变成墨色（整张图同时只亮一个）

export const NS = 'http://www.w3.org/2000/svg';
export const ns = (parent, tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
};

const R = Math.PI / 180;

/** 相机：az 方位角（0–90，默认 25：长边朝前），el 仰角（默认 30） */
export function camera({ az = 25, el = 30, scale = 1, ox = 0, oy = 0 } = {}) {
  const ca = Math.cos(az * R), sa = Math.sin(az * R), se = Math.sin(el * R), ce = Math.cos(el * R);
  const cam = {
    az, el, scale, ox, oy,
    /** 世界坐标 → 屏幕坐标 */
    P(x, y, z = 0) {
      const u = x * ca - y * sa, v = x * sa + y * ca;
      return [cam.ox + cam.scale * u, cam.oy - cam.scale * (v * se + z * ce)];
    },
    /** 深度：越大越靠后，先画 */
    depth(x, y, z = 0) { return x * sa + y * ca - z * 0.001; },
    /** 把一组世界坐标点放进 w×h 的画框（留 pad 边距） */
    fit(points, w, h, pad = 24) {
      cam.scale = 1; cam.ox = 0; cam.oy = 0;
      const s = points.map(p => cam.P(...p));
      const xs = s.map(p => p[0]), ys = s.map(p => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      cam.scale = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0));
      cam.ox = (w - (x1 - x0) * cam.scale) / 2 - x0 * cam.scale;
      cam.oy = (h - (y1 - y0) * cam.scale) / 2 - y0 * cam.scale;
      return cam;
    },
    /** 只按宽度放进画框，返回需要的高度（用来设 viewBox，图不会上下留大片空白） */
    fitWidth(points, w, pad = 24) {
      cam.fit(points, w, 1e6, pad);
      const ys = points.map(p => cam.P(...p)[1]);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      cam.oy += pad - y0;
      return Math.ceil(y1 - y0 + 2 * pad);
    },
  };
  return cam;
}

const f1 = n => (Math.round(n * 10) / 10).toString();
export const poly = pts => 'M' + pts.map(p => `${f1(p[0])} ${f1(p[1])}`).join('L') + 'Z';
export const line = pts => 'M' + pts.map(p => `${f1(p[0])} ${f1(p[1])}`).join('L');

/** 长方体的三个可见面（方位角 0–90 时可见：顶面、-x 面、-y 面） */
export function boxPaths(cam, x, y, z, dx, dy, dz) {
  const P = cam.P;
  const a = P(x, y, z), b = P(x + dx, y, z), c = P(x + dx, y, z + dz), d = P(x, y, z + dz);
  const e = P(x, y + dy, z), g = P(x, y + dy, z + dz), hh = P(x + dx, y + dy, z + dz);
  return {
    top: poly([d, c, hh, g]),
    left: poly([a, d, g, e]),     // -x 面（窄，偏亮）
    front: poly([a, b, c, d]),    // -y 面（宽，偏暗）
  };
}

/** 创建一个长方体零件。tone：'' | 'mid' | 'hi'（决定描边深浅） */
export function solid(parent, { tone = '', cls = '' } = {}) {
  const g = ns(parent, 'g', { class: `iso-solid ${cls}`.trim(), 'data-tone': tone || null });
  const left = ns(g, 'path', { class: 'iso-face iso-left' });
  const front = ns(g, 'path', { class: 'iso-face iso-front' });
  const top = ns(g, 'path', { class: 'iso-face iso-top' });
  return {
    g,
    set(x, y, z, dx, dy, dz, cam) {
      const p = boxPaths(cam, x, y, z, Math.max(dx, 0.01), Math.max(dy, 0.01), Math.max(dz, 0.01));
      top.setAttribute('d', p.top); left.setAttribute('d', p.left); front.setAttribute('d', p.front);
      return this;
    },
    lit(on) { on ? g.setAttribute('data-lit', '') : g.removeAttribute('data-lit'); return this; },
    show(on) { g.style.display = on ? '' : 'none'; return this; },
  };
}

/** 竖直圆柱：顶面椭圆 + 朝向镜头的那半圈侧面（侧面用渐变，不出现色阶） */
export function cylPaths(cam, cx, cy, z, r, h, n = 40) {
  const az = cam.az * R;
  // 朝向镜头的半圈：t ∈ (π − az, 2π − az)，两端是轮廓切点
  const at = (t, zz) => cam.P(cx + r * Math.cos(t), cy + r * Math.sin(t), zz);
  const ring = zz => Array.from({ length: n }, (_, i) => at((i / n) * 2 * Math.PI, zz));
  const half = n / 2, t0 = Math.PI - az;
  const front = [], back = [];
  for (let i = 0; i <= half; i++) front.push(at(t0 + Math.PI * (i / half), z));
  for (let i = half; i >= 0; i--) back.push(at(t0 + Math.PI * (i / half), z + h));
  return { top: poly(ring(z + h)), side: poly([...front, ...back]), base: poly(ring(z)) };
}

export function cyl(parent, { tone = '', cls = '' } = {}) {
  const g = ns(parent, 'g', { class: `iso-solid iso-cyl ${cls}`.trim(), 'data-tone': tone || null });
  const side = ns(g, 'path', { class: 'iso-face iso-side' });
  const top = ns(g, 'path', { class: 'iso-face iso-top' });
  return {
    g,
    set(cx, cy, z, r, h, cam) {
      const p = cylPaths(cam, cx, cy, z, r, Math.max(h, 0.01));
      side.setAttribute('d', p.side); top.setAttribute('d', p.top);
      return this;
    },
    lit(on) { on ? g.setAttribute('data-lit', '') : g.removeAttribute('data-lit'); return this; },
  };
}

/** 球（弹珠）：正圆 + 径向渐变。kind 决定配色：'' 白、'bad' 红、'flag' 深灰 */
export function ball(parent, kind = '') {
  const c = ns(parent, 'circle', { class: 'iso-ball', 'data-kind': kind || null, r: 3 });
  return {
    el: c,
    set(cam, x, y, z, r) { const [sx, sy] = cam.P(x, y, z + r); c.setAttribute('cx', f1(sx)); c.setAttribute('cy', f1(sy)); c.setAttribute('r', f1(r * cam.scale)); return this; },
    kind(k) { if ((c.getAttribute('data-kind') || '') !== k) k ? c.setAttribute('data-kind', k) : c.removeAttribute('data-kind'); return this; },
  };
}

/** 每个 <svg> 里放一次：球和圆柱侧面用的渐变 */
export function defs(svg) {
  const d = ns(svg, 'defs');
  const rg = (id, a, b) => {
    const g = ns(d, 'radialGradient', { id, cx: '38%', cy: '32%', r: '70%' });
    ns(g, 'stop', { offset: '0', 'stop-color': a });
    ns(g, 'stop', { offset: '1', 'stop-color': b });
  };
  rg('iso-ball', 'var(--iso-top)', 'var(--iso-s0)');
  rg('iso-ball-bad', 'var(--iso-red-hi)', 'var(--iso-red)');
  rg('iso-ball-flag', 'var(--iso-mid)', 'var(--iso-hi)');
  const lg = ns(d, 'linearGradient', { id: 'iso-cyl', x1: '0', x2: '1', y1: '0', y2: '0' });
  ns(lg, 'stop', { offset: '0', 'stop-color': 'var(--iso-s3)' });
  ns(lg, 'stop', { offset: '.55', 'stop-color': 'var(--iso-s2)' });
  ns(lg, 'stop', { offset: '1', 'stop-color': 'var(--iso-s0)' });
  return d;
}

/** 平静的弹簧：每帧调用 step(dt)，返回是否还在动 */
export function spring(value, { stiff = 90, damp = 2 * Math.sqrt(90) } = {}) {
  const s = {
    v: value, to: value, rate: 0,
    step(dt) {
      const steps = Math.max(1, Math.ceil(dt / 0.008)), h = dt / steps;
      for (let i = 0; i < steps; i++) { s.rate += ((s.to - s.v) * stiff - s.rate * damp) * h; s.v += s.rate * h; }
      if (Math.abs(s.to - s.v) < 1e-4 && Math.abs(s.rate) < 1e-4) { s.v = s.to; s.rate = 0; return false; }
      return true;
    },
    jump(x) { s.v = s.to = x; s.rate = 0; },
  };
  return s;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
