/* 拨云 3D 地图：只在 ?dev=1 时加载的自检（深度自检 deep=1、方向键等）。在 boyun-map3d.js 之后加载。
   由 scripts/build-map3d.mjs 从 assets/map3d/src/ 按 src/order.js 拼成，不要手改：改 src/ 里的文件，再跑一次 build。 */

/* ---------- src/check3d.js ---------- */
try {
/* 3D 版的深度自检（第 2 轮，只在 ?dev=1&deep=1 时跑）：把 2D 的几项自检搬到读回的画布上，再加几项 3D 才有的。
   - edges / edgesL：只画云，读回 alpha 和“云合成到页面纸上”的明度（L*），找竖直、水平的直边（梯度局部极大连成的段，4px 一格）
   - warmEdge：中式，地形 + 云合成到纸上，暖色成条 / 成边（M.warmEdge，同 2D；原来在 fog.js）
   - specks：中式，孤立的墨点（M.strays，同 2D；原来在 fog.js）
   - hueSpread：中式，光场的色相 / 彩度散布（token）：地、雾、水各自彩度极差 ≤ 0.006、色相极差 ≤ 15°（彩度 < 0.006 的点不算色相；map3d-rules.md 2.3）
   - satChroma：现代、动画。朱的色相 ±25° 以内彩度 p99 ≤ 0.05；现代另看自然色的彩度 p99 ≤ 0.13（2026-10-25 从 0.10 放宽），动画不看这一条（map3d-rules.md 5.1、5.2）
   - labelContrast：云飘到 0 / 10 / 30 秒时，每个地名底下的画面和字色的对比度（取字框里最差的一成）
   - peakOrder：投影后屏幕上的峰高排序和难度排序一致（逆序的对数）。地标的地点不算（它们的山被地标换掉了，块 B）
   - arrows：方向键（页面给了期望表 BOYUN_MAP3D.dev.arrows 时逐格比对，没给就输出算出来的表） */
(function () {
  'use strict';
  var M = window.MAP, M3 = window.MAP3 = window.MAP3 || {};

  /* ---------- 收尾（块 A）：从 2D 的 fog.js 挪过来的三个自检（只在 deep=1 用） ---------- */
  // 第 8 轮自检：暖色成边 / 成条（艺术总监的 warmedge.py 照搬）。px 是合成后的 RGBA（1 个 CSS px 一格），dark：暮。
  // 只看雾和地（按明度、彩度分类）；暖度 = 彩度往色相 75° 的投影；每一类只和同一类比：d = 模糊(w, 2px) − 模糊(w, 48px)；
  // d > 0.005 的像素连成块（≥ 60 格）：长宽比 ≥ 3 且长 ≥ 40 记成条，周长² / 面积 ≥ 60 记成边
  // 第 9 轮自检：孤立的墨点、短划。在合成后的地形 + 雾上（不含路、字）找比四周暗的小块（≤ 80 格、最长 ≤ 14px），
  // 离"墨"（比脚下那块地的颜色暗的大块：山、岸线，≥ 150 格）超过 6px 的就算一个。landY(x, y)：这一格的地色的亮度
  // keep：有含义的小记号（现代的高程点）的位置，离它 8px 以内的不算
  M.strays = function (px, w, h, dark, landY, keep, bigN) {   // bigN：多大算"大块"（中式 150；现代的等高线一截截的，40）
    var N = w * h, Y = new Float32Array(N), BG = new Float32Array(N), T2 = new Float32Array(N), R = 6, i, x, y;
    for (i = 0; i < N; i++) Y[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    var boxB = function (src, dst, tmp) {
      for (y = 0; y < h; y++) { var acc = 0, row = y * w; for (x = -R; x <= R; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]; for (x = 0; x < w; x++) { tmp[row + x] = acc / (2 * R + 1); acc += src[row + Math.min(w - 1, x + R + 1)] - src[row + Math.max(0, x - R)]; } }
      for (x = 0; x < w; x++) { var acc2 = 0; for (y = -R; y <= R; y++) acc2 += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]; for (y = 0; y < h; y++) { dst[y * w + x] = acc2 / (2 * R + 1); acc2 += tmp[Math.min(h - 1, y + R + 1) * w + x] - tmp[Math.max(0, y - R) * w + x]; } }
    };
    boxB(Y, BG, T2);
    // 看得出是"墨"的才算：比四周暗 40（晨）/ 15（暮）以上（淡的坡线、水纹、雾里透出的发丝岸线不算）
    var thr = dark ? 18 : 40, D = new Uint8Array(N); for (i = 0; i < N; i++) if (Y[i] < BG[i] - thr) D[i] = 1;
    // 第 9 轮：按"墨"（比地色暗的格子）连成块来看：大块（≥ 150 格）是山、岸线；小块（≤ 80 格、最长 ≤ 14px）里有看得出的深格子（D），
    // 又离大块超过 6px，才是孤立的墨点、短划（远岸、坡线这种 ≥ 14px 的一笔不算）
    var st = [], S2 = new Uint8Array(N), lab2 = new Int32Array(N), BIG = new Uint8Array(N), comps = [];
    // 很淡的也连上（比地色暗，或比四周暗一点）：一笔淡线上深一点的几截、压在亮水上的岸线都不算孤立
    for (i = 0; i < N; i++) if (Y[i] < landY(i % w, (i / w) | 0) - (dark ? 2 : 4) || Y[i] < BG[i] - (dark ? 6 : 12)) S2[i] = 1;
    for (i = 0; i < N; i++) {
      if (!S2[i] || lab2[i]) continue;
      var c = { n: 0, x0: 1e9, x1: -1, y0: 1e9, y1: -1, px: [], d: 0 }; lab2[i] = 1; st.push(i);
      while (st.length) { var q2 = st.pop(), x2 = q2 % w, y2 = (q2 / w) | 0; c.n++; c.px.push(q2); if (D[q2]) c.d++; if (x2 < c.x0) c.x0 = x2; if (x2 > c.x1) c.x1 = x2; if (y2 < c.y0) c.y0 = y2; if (y2 > c.y1) c.y1 = y2;
        for (var dy2 = -1; dy2 <= 1; dy2++) for (var dx2 = -1; dx2 <= 1; dx2++) { var xx2 = x2 + dx2, yy2 = y2 + dy2; if (xx2 < 0 || yy2 < 0 || xx2 >= w || yy2 >= h) continue; var qq2 = yy2 * w + xx2; if (S2[qq2] && !lab2[qq2]) { lab2[qq2] = 1; st.push(qq2); } } }
      if (c.n >= (bigN || 150)) c.px.forEach(function (q3) { BIG[q3] = 1; }); else comps.push(c);
    }
    // 大块往外扩 6px（可分离的最大值滤波）
    var E1 = new Uint8Array(N), E2 = new Uint8Array(N), K = 6;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) { var m = 0; for (var k = -K; k <= K && !m; k++) { var xk = x + k; if (xk >= 0 && xk < w && BIG[y * w + xk]) m = 1; } E1[y * w + x] = m; }
    for (x = 0; x < w; x++) for (y = 0; y < h; y++) { var m2 = 0; for (var k2 = -K; k2 <= K && !m2; k2++) { var yk = y + k2; if (yk >= 0 && yk < h && E1[yk * w + x]) m2 = 1; } E2[y * w + x] = m2; }
    var out = [];
    comps.forEach(function (c) { if (!c.d || c.n < 2 || c.n > 80 || Math.max(c.x1 - c.x0, c.y1 - c.y0) > 14) return; if (c.px.some(function (q) { return E2[q]; })) return;
      var cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2; if (keep && keep.some(function (k) { return Math.hypot(k[0] - cx, k[1] - cy) < 8; })) return; out.push({ x: Math.round((c.x0 + c.x1) / 2), y: Math.round((c.y0 + c.y1) / 2), n: c.n }); });
    return { n: out.length, list: out.slice(0, 6) };
  };
  // 第 9 轮自检：光只改明度——地、雾、水在舞台上取 9 × 5 个点，按 8 位色算 OKLCH，彩度 ≥ 0.004 的那些看色相差、彩度差
  M.hueSpread = function (st) {
    var out = {};
    ['land', 'fog', 'water'].forEach(function (nm) {
      var f = M.field(nm, st), hs = [], cs = [], c = [0, 0, 0], lab = [0, 0, 0];
      for (var i = 0; i <= 8; i++) for (var j = 0; j <= 4; j++) { f(st.x0 + st.w * i / 8, st.y0 + st.h * j / 4, c); M.oklab([Math.round(c[0]), Math.round(c[1]), Math.round(c[2])], lab); var C = Math.hypot(lab[1], lab[2]); cs.push(C); if (C >= 0.006) hs.push((Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360); }   // 块 B：彩度 < 0.006 的不算色相（map3d-rules.md 2.3；原来 0.004）
      var hd = 0; hs.forEach(function (a) { hs.forEach(function (b) { var d = Math.abs(((a - b + 540) % 360) - 180); if (d > hd) hd = d; }); });
      out[nm] = { hue: +hd.toFixed(1), chroma: +(Math.max.apply(null, cs) - Math.min.apply(null, cs)).toFixed(4) };
    });
    out.ok = ['land', 'fog', 'water'].every(function (k) { return out[k].hue <= 15 && out[k].chroma <= 0.006; });   // 块 B：色相极差 ≤ 15°（map3d-rules.md 2.3；原来 5）
    out.rule = 'C 极差 ≤ 0.006、h 极差 ≤ 15°（C < 0.006 的不算色相）';
    return out;
  };
  M.warmEdge = function (px, w, h, dark) {
    var N = w * h, Lr = new Float32Array(N), Wr = new Float32Array(N), Cr = new Float32Array(N), Hr = new Float32Array(N), lab = [0, 0, 0], c = [0, 0, 0];
    var cs = Math.cos(75 * Math.PI / 180), sn = Math.sin(75 * Math.PI / 180);
    for (var q = 0; q < N; q++) { c[0] = px[q * 4]; c[1] = px[q * 4 + 1]; c[2] = px[q * 4 + 2]; M.oklab(c, lab); Lr[q] = lab[0]; Cr[q] = Math.hypot(lab[1], lab[2]); Hr[q] = (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360; Wr[q] = Math.max(0, lab[1] * cs + lab[2] * sn); }
    var classes = dark ? [function (i) { return Lr[i] > 0.24 && Lr[i] < 0.56 && Cr[i] < 0.08; }] : [function (i) { return Lr[i] > 0.952 && Cr[i] < 0.03; }, function (i) { return Lr[i] > 0.895 && Lr[i] <= 0.952 && Cr[i] < 0.06; }];
    var tmp = new Float32Array(N);
    function box(a, r) {
      var k = 2 * r + 1, x, y, acc;
      for (y = 0; y < h; y++) { var row = y * w; acc = 0; for (x = -r; x <= r; x++) acc += a[row + (x < 0 ? 0 : x >= w ? w - 1 : x)]; for (x = 0; x < w; x++) { tmp[row + x] = acc / k; var xa = x + r + 1, xb = x - r; acc += a[row + (xa >= w ? w - 1 : xa)] - a[row + (xb < 0 ? 0 : xb)]; } }
      for (x = 0; x < w; x++) { acc = 0; for (y = -r; y <= r; y++) acc += tmp[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + x]; for (y = 0; y < h; y++) { a[y * w + x] = acc / k; var ya = y + r + 1, yb = y - r; acc += tmp[(ya >= h ? h - 1 : ya) * w + x] - tmp[(yb < 0 ? 0 : yb) * w + x]; } }
    }
    function blur(src, sigma) { var a = new Float32Array(src), r = Math.max(1, Math.round(sigma * 0.87)); box(a, r); box(a, r); box(a, r); return a; }
    var keep = new Uint8Array(N), D = new Float32Array(N);
    classes.forEach(function (fk) {
      var kf = new Float32Array(N), wk = new Float32Array(N);
      for (var i = 0; i < N; i++) if (fk(i)) { kf[i] = 1; wk[i] = Wr[i]; keep[i] = 1; }
      var n2 = blur(wk, 2), k2 = blur(kf, 2), n48 = blur(wk, 48), k48 = blur(kf, 48);
      for (var i2 = 0; i2 < N; i2++) if (kf[i2]) D[i2] += n2[i2] / Math.max(k2[i2], 1e-6) - n48[i2] / Math.max(k48[i2], 1e-6);
    });
    var mask = new Uint8Array(N), area = 0, nm = 0;
    for (var q2 = 0; q2 < N; q2++) { if (keep[q2]) area++; if (keep[q2] && D[q2] > 0.005) { mask[q2] = 1; nm++; } }
    var seen = new Uint8Array(N), strips = 0, edges = 0, big = [], st2 = [];
    for (var q3 = 0; q3 < N; q3++) {
      if (!mask[q3] || seen[q3]) continue;
      var pts = []; seen[q3] = 1; st2.push(q3);
      while (st2.length) { var cq = st2.pop(), cx = cq % w, cy = (cq / w) | 0; pts.push(cq); [cx > 0 ? cq - 1 : -1, cx < w - 1 ? cq + 1 : -1, cy > 0 ? cq - w : -1, cy < h - 1 ? cq + w : -1].forEach(function (nq) { if (nq >= 0 && mask[nq] && !seen[nq]) { seen[nq] = 1; st2.push(nq); } }); }
      if (pts.length < 60) continue;
      var mx = 0, my = 0, n = pts.length; pts.forEach(function (pq) { mx += pq % w; my += (pq / w) | 0; }); mx /= n; my /= n;
      var sxx = 0, syy = 0, sxy = 0; pts.forEach(function (pq) { var dx = pq % w - mx, dy = ((pq / w) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }); sxx /= n - 1; syy /= n - 1; sxy /= n - 1;
      var tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det)), e1 = Math.max(1e-6, tr / 2 + disc), e2 = Math.max(1e-6, tr / 2 - disc);
      var elong = Math.sqrt(e1 / e2), len = 4 * Math.sqrt(e1), set = {}; pts.forEach(function (pq) { set[pq] = 1; });
      var per = 0; pts.forEach(function (pq) { var x = pq % w; if (!set[pq - w] || pq < w) per++; if (!set[pq + w] || pq + w >= N) per++; if (x === 0 || !set[pq - 1]) per++; if (x === w - 1 || !set[pq + 1]) per++; });
      var compact = per * per / n, kind = '';
      if (elong >= 3 && len >= 40) { strips++; kind += '条'; }
      if (compact >= 60) { edges++; kind += '边'; }
      if (kind) big.push({ x: Math.round(mx), y: Math.round(my), n: n, elong: +elong.toFixed(1), len: Math.round(len), compact: Math.round(compact), kind: kind });
    }
    var out = { struct: +(100 * nm / Math.max(area, 1)).toFixed(2), strips: strips, edges: edges, top: big.sort(function (a, b) { return b.n - a.n; }).slice(0, 4) };
    if (M.__warmMask) { M.__warmMask = { mask: mask, keep: keep, w: w, h: h }; }
    if (dark) { var wp = 0; for (var q4 = 0; q4 < N; q4++) if (keep[q4] && Cr[q4] > 0.012 && Hr[q4] > 30 && Hr[q4] < 100) wp++; out.warmPct = +(100 * wp / Math.max(area, 1)).toFixed(3); }
    return out;
  };

  function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function relY(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function lstar(Y) { return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y; }

  /* 骨架第 5 轮（天光第 1 轮“要别人给的”第 2 条）：页面底现在是天光的渐变（sky.css，默认开，background-attachment: fixed），不是一张平的 --paper。
     M3.pageBg(x0, y0, W, H)：把 body 的背景（background-color + 一层层 linear / radial-gradient，读 computed style）在画布 2D 上照样画一遍，
     返回视口里 (x0, y0) 起 W × H 那一块的 RGBA。只认 sky.css、ani.css 用到的写法：linear-gradient(角度, 色标…)、radial-gradient(宽 高 at x y, 色标…)；认不出的层跳过。
     M3.paperWorst()：整个视口的背景（5 × 5 平均，压渐变的抖动），CIE L* 最亮、最暗的两处（R6 雾对纸取其中最不利的那一处，tools/r6.py 读它） */
  function splitTop(sx) { var out = [], d = 0, st = 0; for (var i = 0; i < sx.length; i++) { var ch = sx[i]; if (ch === '(') d++; else if (ch === ')') d--; else if (ch === ',' && d === 0) { out.push(sx.slice(st, i).trim()); st = i + 1; } } out.push(sx.slice(st).trim()); return out.filter(Boolean); }
  function lenOf(v, ref) { v = v.trim(); return /%$/.test(v) ? parseFloat(v) / 100 * ref : parseFloat(v); }
  function stopsOf(parts) {
    var st = parts.map(function (p) { var m = /^(.*\))\s*([-\d.]+%)?$/.exec(p.trim()) || /^(#[0-9a-fA-F]+|\w+)\s*([-\d.]+%)?$/.exec(p.trim()); return m ? { c: m[1], t: m[2] != null ? parseFloat(m[2]) / 100 : null } : null; }).filter(Boolean);
    st.forEach(function (o, i) { if (o.t == null) o.t = st.length > 1 ? i / (st.length - 1) : 0; });
    return st;
  }
  M3.pageBg = function (x0, y0, W, H) {
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H; var g = cv.getContext('2d'), cs = getComputedStyle(document.body), vw = innerWidth, vh = innerHeight;
    g.fillStyle = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : (M.tok('--paper') || '#fff'); g.fillRect(0, 0, W, H);
    var bi = cs.backgroundImage; if (!bi || bi === 'none') return g.getImageData(0, 0, W, H).data;
    splitTop(bi).reverse().forEach(function (L) {   // 写在前面的层在上面：倒着画
      var m = /^(linear|radial)-gradient\((.*)\)$/.exec(L); if (!m) return;
      var parts = splitTop(m[2]), gr = null;
      try {
        if (m[1] === 'linear') {
          var ang = Math.PI, a0 = parts[0];
          if (/deg$/.test(a0)) { ang = parseFloat(a0) * Math.PI / 180; parts = parts.slice(1); } else if (/^to /.test(a0)) { ang = { 'to bottom': 180, 'to top': 0, 'to right': 90, 'to left': 270 }[a0] * Math.PI / 180; parts = parts.slice(1); }
          var dx = Math.sin(ang), dy = -Math.cos(ang), len = Math.abs(vw * dx) + Math.abs(vh * dy), cx = vw / 2 - x0, cy = vh / 2 - y0;
          gr = g.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2);
          stopsOf(parts).forEach(function (o) { gr.addColorStop(M.clamp(o.t, 0, 1), o.c); });
          g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = gr; g.fillRect(0, 0, W, H);
        } else {
          var sh = /^([\d.]+(?:%|px))\s+([\d.]+(?:%|px))\s+at\s+([-\d.]+(?:%|px))\s+([-\d.]+(?:%|px))$/.exec(parts[0]); if (!sh) return;
          var rx = lenOf(sh[1], vw), ry = lenOf(sh[2], vh), px = lenOf(sh[3], vw) - x0, py = lenOf(sh[4], vh) - y0;
          gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
          stopsOf(parts.slice(1)).forEach(function (o) { gr.addColorStop(M.clamp(o.t, 0, 1), o.c); });
          g.setTransform(1, 0, 0, ry / rx, px, py); g.fillStyle = gr; g.fillRect(-px, -py * rx / ry, W, H * rx / ry); g.setTransform(1, 0, 0, 1, 0, 0);
        }
      } catch (e) { g.setTransform(1, 0, 0, 1, 0, 0); }
    });
    return g.getImageData(0, 0, W, H).data;
  };
  M3.paperWorst = function () {
    var W = innerWidth, H = innerHeight, bg = M3.pageBg(0, 0, W, H), best = { lo: null, hi: null };
    for (var y = 2; y < H - 2; y += 3) for (var x = 2; x < W - 2; x += 3) {
      var r = 0, gg = 0, b = 0; for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) { var o = ((y + dy) * W + x + dx) * 4; r += bg[o]; gg += bg[o + 1]; b += bg[o + 2]; }
      var c = [r / 25, gg / 25, b / 25], L = lstar(relY(c));
      if (!best.lo || L < best.lo.L) best.lo = { L: L, c: c, at: [x, y] }; if (!best.hi || L > best.hi.L) best.hi = { L: L, c: c, at: [x, y] };
    }
    var hx = function (c) { return '#' + c.map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join('').toUpperCase(); };
    return { lo: hx(best.lo.c), loAt: best.lo.at, loL: +best.lo.L.toFixed(2), hi: hx(best.hi.c), hiAt: best.hi.at, hiL: +best.hi.L.toFixed(2), flat: !getComputedStyle(document.body).backgroundImage || getComputedStyle(document.body).backgroundImage === 'none' };
  };

  // 读回画布（opts.cloudsOnly：只画云；t：云的时间），合成到页面的纸上，返回 CSS px 分辨率的 RGBA（上下已翻正）
  // 骨架第 5 轮：纸 = 画布后面那一处页面底的颜色（天光的渐变，M3.pageBg），不再是一张平的 --paper
  function grab(u, opts) {
    var SC = u.SC, clouds = u.clouds, gl = SC.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    var hide = [];
    if (opts.cloudsOnly) SC.scene.children.forEach(function (o) { if (o !== clouds.group && o.visible) { o.visible = false; hide.push(o); } });
    if (opts.terrainOnly && clouds.group.visible) { clouds.group.visible = false; hide.push(clouds.group); }
    var sh = clouds.group.children.filter(function (m) { return m.renderOrder === 5 && m.visible; }); if (opts.cloudsOnly) sh.forEach(function (m) { m.visible = false; hide.push(m); });
    var dec = SC.U.uDecal.value; if (opts.noDecal) { if (!M3.__blank) { M3.__blank = new THREE.DataTexture(new Uint8Array(4), 1, 1); M3.__blank.needsUpdate = true; } SC.U.uDecal.value = M3.__blank; }
    var t0 = u.tCloud(); if (opts.t != null) u.setTime(opts.t); else u.renderNow();
    var px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    SC.U.uDecal.value = dec; hide.forEach(function (o) { o.visible = true; }); if (opts.t != null) u.setTime(t0); else u.renderNow();
    var dpr = w / u.view.w, W = Math.round(w / dpr), H = Math.round(h / dpr), out = new Uint8ClampedArray(W * H * 4), A = new Float32Array(W * H), pap = M.rgb(M.tok('--paper'));
    var rc = SC.renderer.domElement.getBoundingClientRect(), BG = M3.pageBg(Math.round(rc.left), Math.round(rc.top), W, H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var sx = Math.min(w - 1, Math.round(x * dpr)), sy = h - 1 - Math.min(h - 1, Math.round(y * dpr)), o = (sy * w + sx) * 4, a = px[o + 3] / 255, q = y * W + x;
      // 画布是预乘 alpha：合成 = 颜色 + 纸 × (1 − a)
      out[q * 4] = px[o] + BG[q * 4] * (1 - a); out[q * 4 + 1] = px[o + 1] + BG[q * 4 + 1] * (1 - a); out[q * 4 + 2] = px[o + 2] + BG[q * 4 + 2] * (1 - a); out[q * 4 + 3] = 255; A[q] = a;
    }
    return { rgba: out, a: A, w: W, h: H };
  }
  // 直边：在 4px 的格子上，竖边 = 同一列上、上下连着好几格都在左右之间突变（且是梯度的局部极大）；横边同理
  function straightEdges(V, nx, ny, thr) {
    var v = { len: 0 }, hh = { len: 0 }, i, j, run;
    var gx = function (i2, j2) { return i2 < 0 || i2 >= nx - 1 ? 0 : Math.abs(V[j2 * nx + i2 + 1] - V[j2 * nx + i2]); }, gy = function (i2, j2) { return j2 < 0 || j2 >= ny - 1 ? 0 : Math.abs(V[(j2 + 1) * nx + i2] - V[j2 * nx + i2]); };
    for (i = 0; i < nx - 1; i++) { run = 0; for (j = 0; j < ny; j++) { var d = gx(i, j); if (d > thr && d >= gx(i - 1, j) && d >= gx(i + 1, j)) { run++; if (run > v.len) v = { len: run, x: i * 4, y: j * 4 }; } else run = 0; } }
    for (j = 0; j < ny - 1; j++) { run = 0; for (i = 0; i < nx; i++) { var e = gy(i, j); if (e > thr && e >= gy(i, j - 1) && e >= gy(i, j + 1)) { run++; if (run > hh.len) hh = { len: run, x: i * 4, y: j * 4 }; } else run = 0; } }
    return { v: v, h: hh };
  }
  function cells(img, fn) {
    var nx = Math.floor(img.w / 4), ny = Math.floor(img.h / 4), V = new Float32Array(nx * ny);
    for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) { var s = 0; for (var dy = 0; dy < 4; dy++) for (var dx = 0; dx < 4; dx++) s += fn((j * 4 + dy) * img.w + i * 4 + dx); V[j * nx + i] = s / 16; }
    return { V: V, nx: nx, ny: ny };
  }

  // 方向键的期望表：页面可以给一张人工核过的表（BOYUN_MAP3D.dev.arrows：{ 地点 id: { L, R, U, D } }，'-' = 没有），deep 自检逐格比；
  // 没给就只输出算出来的表（arrowsTable）。收尾（块 A）：原来这张表（原型的 12 个地点）写死在这里（M3.ARROWS），挪到了页面给的数据里
  M3.deepCheck = function (check) {
    var u = M3.ui, th = M.theme(), t0 = performance.now(), out = { done: false }; check.deep = out;
    var Q = [], run = function () { var f = Q.shift(); if (!f) { out.ms = Math.round(performance.now() - t0); out.done = true; return; } try { f(); } catch (e) { out.error = String(e); } setTimeout(run, 700); };
    // 1 直边：只画云
    var full, bare;
    Q.push(function () {
    var cl = grab(u, { cloudsOnly: true });
    var ca = cells(cl, function (q) { return cl.a[q]; }), cL = cells(cl, function (q) { return lstar(relY([cl.rgba[q * 4], cl.rgba[q * 4 + 1], cl.rgba[q * 4 + 2]])); });
    out.edges = straightEdges(ca.V, ca.nx, ca.ny, 0.3); out.edgesL = straightEdges(cL.V, cL.nx, cL.ny, 6);
    });
    // 2 合成（地形 + 云）
    Q.push(function () { full = grab(u, {}); });
    Q.push(function () { bare = grab(u, { noDecal: true }); });   // 孤立墨点不算路（同 2D：不含路和字）
    Q.push(function () {
    if (th.cn) {
      var we = M.warmEdge(full.rgba, full.w, full.h, th.dark); out.warmEdge = { strips: we.strips, edges: we.edges, struct: we.struct, warmPct: we.warmPct, top: we.top };
      var lf = M.field('land', u.stage), LG = 8, gw = Math.ceil(full.w / LG) + 1, gh = Math.ceil(full.h / LG) + 1, LY = new Float32Array(gw * gh), cc = [0, 0, 0];
      for (var gj = 0; gj < gh; gj++) for (var gi = 0; gi < gw; gi++) { var gp = u.SC.groundAt(gi * LG + u.view.pan, gj * LG, M3.P.L0); lf(gp.x, gp.y, cc); LY[gj * gw + gi] = 0.2126 * cc[0] + 0.7152 * cc[1] + 0.0722 * cc[2]; }
      out.specks = M.strays(bare.rgba, bare.w, full.h, th.dark, function (x, y) { return LY[Math.round(y / LG) * gw + Math.round(x / LG)]; }, [], 150);
      out.hueSpread = M.hueSpread(u.stage);
    } else {
      // 自然色的彩度上限：只看地形（不画云）
      var terr = grab(u, { terrainOnly: true }), acc = M.oklab(M.rgb(M.tok('--accent'))), ah = Math.atan2(acc[2], acc[1]) * 180 / Math.PI, lab = [0, 0, 0], Cs = [], Cn = [];
      for (var q = 0; q < terr.w * terr.h; q += 3) { if (full.a[q] < 0.9) continue; M.oklab([terr.rgba[q * 4], terr.rgba[q * 4 + 1], terr.rgba[q * 4 + 2]], lab); var C = Math.hypot(lab[1], lab[2]), hu = Math.atan2(lab[2], lab[1]) * 180 / Math.PI, dh = Math.abs(((hu - ah + 540) % 360) - 180); Cs.push(C); if (dh <= 25) Cn.push(C); }
      Cs.sort(function (a, b) { return a - b; }); Cn.sort(function (a, b) { return a - b; });
      var p99 = function (A) { return A.length ? +A[Math.floor(A.length * 0.99)].toFixed(3) : 0; };
      // 块 B：现代 p99 ≤ 0.13（原来 0.10，2026-10-25 照用户的偏好放宽）；动画只看朱附近（map3d-rules.md 5.1、5.2）
      var aniT = !!(M3.isAni && M3.isAni());
      out.satChroma = { p99: p99(Cs), nearAccentP99: p99(Cn), p99Limit: aniT ? null : 0.13, ok: (aniT || p99(Cs) <= 0.13) && p99(Cn) <= 0.05 };
    }
    });
    // 3 字的对比度：云在 0 / 10 / 30 秒
    var ink1 = relY(M.rgb(M.tok('--ink-1'))), ink2 = relY(M.rgb(M.tok('--ink-2'))), labs = u.labs(), worst = {};
    [0, 10, 30].forEach(function (t) { Q.push(function () {
      var img = grab(u, { t: t });
      u.places.forEach(function (p) {
        var o = labs[p.id], el = document.querySelector('#over .lab[data-id="' + p.id + '"]'), wk = el && el.classList.contains('wk'), Yt = wk ? ink2 : ink1, ys = [];
        // 现代的字有 4px 的不透明描边（亮地上白、暗地上黑，透明度 0.92）：字是写在描边上的，底色 = 描边色 × 0.92 + 画面 × 0.08
        var hs = el && !M.theme().cn ? getComputedStyle(el).stroke : '', hm = /rgba?\(([^)]*)\)/.exec(hs), halo = hm ? hm[1].split(',').map(Number) : null;
        for (var y = Math.round(o.r.y0) + 2; y < o.r.y1 - 2; y += 2) for (var x = Math.round(o.r.x0 - u.view.pan) + 3; x < o.r.x1 - u.view.pan - 3; x += 2) { if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue; var q2 = y * img.w + x, bg = [img.rgba[q2 * 4], img.rgba[q2 * 4 + 1], img.rgba[q2 * 4 + 2]]; if (halo) { var ha = halo.length > 3 ? halo[3] : 1; bg = [halo[0] * ha + bg[0] * (1 - ha), halo[1] * ha + bg[1] * (1 - ha), halo[2] * ha + bg[2] * (1 - ha)]; } ys.push(relY(bg)); }
        if (!ys.length) return;
        var cr = ys.map(function (Yb) { return (Math.max(Yb, Yt) + 0.05) / (Math.min(Yb, Yt) + 0.05); }).sort(function (a, b) { return a - b; }), c10 = cr[Math.floor(cr.length * 0.1)];
        if (!(p.label in worst) || c10 < worst[p.label]) worst[p.label] = +c10.toFixed(2);
      });
    }); });
    Q.push(function () {
    var low = Object.keys(worst).filter(function (k) { return worst[k] < 4.5; });
    // onFog：雾里（一个概念都没学、不是今晚）的地名各自最差的那一成。收尾（块 A）：原来写死三个地名，改成按状态挑
    var fogLabs = u.places.filter(function (p) { return p.state === 'week' && p !== M.state.focus; }).map(function (p) { return p.label; });
    out.labelContrast = { min: Math.min.apply(null, Object.keys(worst).map(function (k) { return worst[k]; })), below45: low, onFog: fogLabs.filter(function (k) { return k in worst; }).map(function (k) { return k + ' ' + worst[k]; }) };
    // 4 峰高的排序（投影后屏幕上的高度）
    var lmP = new Set((M3.LM && M3.LM.plans || []).map(function (pl) { return pl.p; }));   // 块 B：地标的地点不算（山被地标换掉了，峰高不表示难度）
    var ph = u.Wd.peaks.filter(function (pk) { return !lmP.has(pk.p); }).map(function (pk) { var top = u.SC.project(pk.cx, pk.pz, u.Wd.hAt(pk.cx, pk.pz)), bot = u.SC.project(pk.cx, pk.pz, u.Wd.LANDH[Math.round((pk.pz - u.Wd.GY) / u.Wd.CELL) * u.Wd.NX + Math.round((pk.cx - u.Wd.GX) / u.Wd.CELL)] || M3.P.L0); return { d: pk.k.d, h: bot[1] - top[1], main: pk.main, label: pk.p.label }; });
    var inv = 0; ph.forEach(function (a) { ph.forEach(function (b) { if (a.d > b.d && a.h <= b.h) inv++; }); });
    var byD = {}; ph.forEach(function (o) { (byD[o.d] = byD[o.d] || []).push(o.h); });
    out.peakOrder = { inversions: inv, px: Object.keys(byD).map(function (d) { var a = byD[d]; return d + ':' + Math.round(Math.min.apply(null, a)) + '–' + Math.round(Math.max.apply(null, a)); }).join(' ') };
    // 最难的那个地点的主峰在屏幕上多高（原来写死一个地点的名字，叫 awaitPx）
    var dTop = Math.max.apply(null, u.places.map(function (p) { return p.d; })), aw = ph.filter(function (o) { return o.main && u.places.some(function (p) { return p.label === o.label && p.d === dTop; }); })[0];
    if (aw) { out.peakOrder.topPx = Math.round(aw.h); out.peakOrder.topLabel = aw.label; }
    // 5 方向键
    var ARROWS = M.state.data.dev && M.state.data.dev.arrows;
    if (ARROWS && !Object.keys(ARROWS).some(function (k) { return !u.places.some(function (p) { return p.id === k; }); })) {
      var miss = [], dirs = { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] };
      u.places.forEach(function (p) { Object.keys(dirs).forEach(function (k) { var n = u.neighbour(p, dirs[k]), got = n ? n.id : '-', want = (ARROWS[p.id] || {})[k] || '-'; if (got !== want) miss.push(p.id + k + ':' + got + '≠' + want); }); });
      out.arrows = { cells: u.places.length * 4, miss: miss.length, list: miss.slice(0, 6) };
    } else {
      var tab = {}; u.places.forEach(function (p) { tab[p.id] = {}; [['L', [-1, 0]], ['R', [1, 0]], ['U', [0, -1]], ['D', [0, 1]]].forEach(function (k) { var n = u.neighbour(p, k[1]); tab[p.id][k[0]] = n ? n.id : '-'; }); });
      out.arrowsTable = tab;
    }
    });
    run();
  };
})();
} catch (e) { (window.MAP3_LOAD_ERRORS = window.MAP3_LOAD_ERRORS || []).push({ file: 'check3d.js', error: String(e && e.stack || e) }); console.error('[boyun-map3d] src/check3d.js 出错', e); }
