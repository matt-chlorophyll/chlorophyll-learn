/* 拨云 Boyun — fog, veil, choice and map. Vanilla, no dependencies. window.Boyun */
(function () {
  'use strict';
  var W = window, D = document, NS = 'http://www.w3.org/2000/svg';
  var B = W.Boyun = W.Boyun || {};

  function css(n, f) { var v = getComputedStyle(D.documentElement).getPropertyValue(n).trim(); return v || f; }
  function num(n, f) { var v = parseFloat(css(n, '')); return isNaN(v) ? f : v; }
  function el(n, a, p) { var e = D.createElementNS(NS, n); for (var k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; }
  function sm(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
  function rng(s) { var a = s >>> 0 || 1; return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hex(h) { h = (h || '').trim(); if (h[0] !== '#') return [250, 250, 248]; if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]; return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function reduced() { return !!(W.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function texture() { return css('--by-texture', 'ink') === 'grain' ? 'grain' : 'ink'; }
  function press(n, f) { n.addEventListener('click', f); n.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); f(e); } }); }
  function onTheme(fn) {
    var mo = new MutationObserver(fn); mo.observe(D.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    if (W.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fn);
    return mo;
  }

  /* ---------- memory model ---------- */
  B.R = function (ageDays, S) { return Math.exp(-Math.max(0, ageDays) / Math.max(0.01, S)); };
  B.level = function (R) { return R >= 0.8 ? 1 : R >= 0.6 ? 2 : R >= 0.4 ? 3 : R >= 0.2 ? 4 : 5; };
  B.sight = function (S) { return num('--mist-sight', 46) + num('--mist-sight-k', 30) * Math.log(1 + S); };

  /* ---------- fog field ----------
     sources  [{x, y, w, r}]      clear discs: w = visibility (0..1), r = sight radius
     glimpses [{x, y, w, rx, ry}] thin mist over a frontier's name
     worlds   [{x, y, r}]         fog that never lifts */
  function Field(w, h, cell) {
    this.w = w; this.h = h; this.c = cell || 10; this.fw = Math.ceil(w / this.c); this.fh = Math.ceil(h / this.c);
    this.off = D.createElement('canvas'); this.off.width = this.fw; this.off.height = this.fh;
    this.ctx = this.off.getContext('2d'); this.img = this.ctx.createImageData(this.fw, this.fh);
    this.noise = new Float32Array(this.fw * this.fh); this.tex = '';
  }
  Field.prototype.makeNoise = function () {
    var t = texture(); if (t === this.tex) return; this.tex = t;
    var r = rng(7), GW = 13, GH = 9, G = [], i, x, y, fw = this.fw, fh = this.fh;
    for (i = 0; i < GW * GH; i++) G.push(r());
    for (y = 0; y < fh; y++) for (x = 0; x < fw; x++) {
      var gx = x / fw * (GW - 1), gy = y / fh * (GH - 1), x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
      var v = (G[y0 * GW + x0] * (1 - fx) + G[y0 * GW + x0 + 1] * fx) * (1 - fy) + (G[(y0 + 1) * GW + x0] * (1 - fx) + G[(y0 + 1) * GW + x0 + 1] * fx) * fy;
      this.noise[y * fw + x] = t === 'ink' ? v * 0.85 + r() * 0.15 : v * 0.3 + r() * 0.7;
    }
  };
  Field.prototype.paint = function (ctx, dw, dh, src, gl, worlds) {
    this.makeNoise();
    var pr = hex(css('--fog', '#fbfbf9')), inner = num('--mist-inner', 0.45), wmin = num('--mist-world', 0.88);
    var ca = this.tex === 'ink' ? 11 : 7, amp = this.tex === 'ink' ? 0.24 : 0.12;
    var d = this.img.data, c = this.c, fw = this.fw, fh = this.fh, i, cx, cy;
    for (cy = 0; cy < fh; cy++) {
      var y = (cy + 0.5) * c;
      for (cx = 0; cx < fw; cx++) {
        var x = (cx + 0.5) * c, v = 0;
        for (i = 0; i < src.length; i++) {
          var s = src[i];
          if (s.w > 0.003 && s.r > 1) { var dx = x - s.x, dy = y - s.y, u = Math.sqrt(dx * dx + dy * dy) / s.r; if (u < 1.05) { var f = u < inner ? 1 : sm((1.05 - u) / (1.05 - inner)), vv = s.w * f; if (vv > v) v = vv; } }
        }
        for (i = 0; i < gl.length; i++) {
          var g = gl[i];
          if (g.w > 0.003) { var gx = (x - g.x) / g.rx, gy = (y - g.y) / g.ry, ug = Math.sqrt(gx * gx + gy * gy); if (ug < 1) { var vg = g.w * sm(1 - ug); if (vg > v) v = vg; } }
        }
        var a = 1 - v;
        for (i = 0; i < worlds.length; i++) { var wd = worlds[i], wx = x - wd.x, wy = y - wd.y, wdist = Math.sqrt(wx * wx + wy * wy); if (wdist < wd.r) a = Math.max(a, sm(1 - wdist / wd.r) * wmin); }
        var n = this.noise[cy * fw + cx];
        a += (n - 0.5) * amp * a * (1 - a) * 4; a = a < 0 ? 0 : a > 1 ? 1 : a;
        var nz = (n - 0.5) * ca, k = (cy * fw + cx) * 4;
        d[k] = pr[0] + nz; d[k + 1] = pr[1] + nz; d[k + 2] = pr[2] + nz * 1.15; d[k + 3] = Math.round(a * 255);
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.off, 0, 0, dw, dh);
  };
  B.Field = Field;

  /* ---------- tweening: fast in, slow settle ---------- */
  function Tween(items, keys, draw) {
    var raf = 0, last = 0;
    function step(now) {
      var dt = Math.min(64, now - last); last = now;
      var k = reduced() ? 1 : 1 - Math.exp(-dt / num('--mist-tau', 420)), moving = false;
      items().forEach(function (it) {
        keys.forEach(function (p) {
          var d = it[p + 'T'] - it[p]; if (Math.abs(d) > (p === 'r' ? 0.4 : 0.003)) { it[p] += d * k; moving = true; } else it[p] = it[p + 'T'];
        });
      });
      draw(); raf = moving ? requestAnimationFrame(step) : 0;
    }
    return function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); } };
  }

  /* ---------- Boyun.fog(canvas, opts): a bare fog layer ---------- */
  B.fog = function (canvas, o) {
    o = o || {};
    var w = o.width || 600, h = o.height || 360, field = new Field(w, h, o.cell || 10), ctx = canvas.getContext('2d');
    canvas.width = w; canvas.height = h;
    var src = (o.sources || []).map(function (s) { return { x: s.x, y: s.y, w: s.w || 0, r: s.r || 0, wT: s.w || 0, rT: s.r || 0 }; });
    var gl = (o.glimpses || []).map(function (g) { return { x: g.x, y: g.y, rx: g.rx || 60, ry: g.ry || 30, w: g.w || 0, wT: g.w || 0 }; });
    var worlds = o.worlds || [];
    function draw() { ctx.clearRect(0, 0, w, h); if (o.under) o.under(ctx); field.paint(ctx, w, h, src, gl, worlds); }
    var kick = Tween(function () { return src.concat(gl); }, ['w', 'r'], draw);
    onTheme(function () { field.tex = ''; draw(); });
    draw();
    return {
      sources: src, glimpses: gl, worlds: worlds, redraw: draw,
      clear: function (x, y, r, wv) { src.push({ x: x, y: y, w: 0, r: 0, wT: wv == null ? 1 : wv, rT: r }); kick(); },
      set: function (i, wv, r) { var s = src[i]; if (!s) return; s.wT = wv; if (r != null) s.rT = r; kick(); },
      animate: kick
    };
  };

  /* ---------- Boyun.choice(root, opts): 先猜 ---------- */
  B.choice = function (root, o) {
    o = o || {};
    var btns = [].slice.call(root.querySelectorAll('.by-opt')), trace = o.trace || root.querySelector('.by-trace'), done = false;
    btns.forEach(function (b, i) {
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () {
        if (done) return; done = true;
        btns.forEach(function (x) { x.disabled = true; x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        var label = b.textContent.trim(), txt = o.traceText ? o.traceText(i, label) : '你先猜：' + label + '。';
        if (o.answer != null && o.answer >= 0 && i !== o.answer && !o.traceText) txt += '多数人第一次也这么猜。';
        if (trace) trace.textContent = txt;
        if (o.onPick) o.onPick(i, label);
      });
    });
    return { reset: function () { done = false; btns.forEach(function (x) { x.disabled = false; x.setAttribute('aria-pressed', 'false'); }); if (trace) trace.textContent = ''; } };
  };

  /* ---------- Boyun.veil(wrapper, opts): fog in the reading order ---------- */
  B.veil = function (wrap, o) {
    o = o || {};
    wrap.classList.add('by-veil');
    var steps = [].slice.call(wrap.querySelectorAll(o.step || '.by-step')), front = o.front || 0;
    var mist = wrap.querySelector('.by-veil__mist');
    if (!mist) { mist = D.createElement('div'); mist.className = 'by-veil__mist'; mist.setAttribute('aria-hidden', 'true'); wrap.appendChild(mist); }
    function place(anim) {
      mist.classList.toggle('is-anim', !!anim && !reduced());
      steps.forEach(function (s, i) { s.inert = i >= front && front < steps.length; s.setAttribute('aria-hidden', i > front ? 'true' : 'false'); });
      if (front >= steps.length) { mist.style.top = (wrap.offsetHeight + 48) + 'px'; mist.style.opacity = '0'; }
      else { mist.style.top = steps[front].offsetTop + 'px'; mist.style.opacity = '1'; }
    }
    place(false);
    if (W.ResizeObserver) new ResizeObserver(function () { place(false); }).observe(wrap);
    return {
      next: function () { front = Math.min(steps.length, front + 1); place(true); },
      reveal: function (k) { front = Math.max(front, Math.min(steps.length, k)); place(true); },
      all: function () { front = steps.length; place(true); },
      refresh: function () { place(false); },
      get front() { return front; }
    };
  };

  /* ---------- Boyun.map(container, cfg): the explorable map ----------
     cfg: { width, height, nodes:[{id,x,y,label,region?}], edges:[[a,b]], regions:[{label,x,y}],
            explored:{ id:{S, age} }, focus:'id', order:['id',...], worlds:[{x,y,r,label,adj}],
            onSelect(info) }  info = { node, state:'explored'|'frontier'|'world', R } */
  B.map = function (box, cfg) {
    var Wd = cfg.width || 1200, Ht = cfg.height || 720, nodes = cfg.nodes, edges = cfg.edges || [], worlds = cfg.worlds || [];
    var by = {}; nodes.forEach(function (n) { by[n.id] = n; n.lw = (n.label || '').length * 15 + 4; n.w = 0; n.r = 0; n.g = 0; });
    var ex = {}; Object.keys(cfg.explored || {}).forEach(function (k) { ex[k] = { S: cfg.explored[k].S, age: cfg.explored[k].age || 0 }; });
    var T = 0, focus = cfg.focus || null, sel = null, order = cfg.order || nodes.map(function (n) { return n.id; });
    box.classList.add('by-map'); box.innerHTML = '';
    var scroll = D.createElement('div'); scroll.className = 'by-map__scroll'; box.appendChild(scroll);
    var inner = D.createElement('div'); inner.className = 'by-map__inner'; inner.style.aspectRatio = Wd + ' / ' + Ht; scroll.appendChild(inner);
    var terr = el('svg', { viewBox: '0 0 ' + Wd + ' ' + Ht, 'aria-hidden': 'true' }, inner);
    var cv = D.createElement('canvas'); cv.className = 'by-map__fog'; cv.width = Wd; cv.height = Ht; cv.setAttribute('aria-hidden', 'true'); inner.appendChild(cv);
    var over = el('svg', { viewBox: '0 0 ' + Wd + ' ' + Ht, role: 'group', 'aria-label': cfg.label || '知识地图：能看见名字的地方可以探索' }, inner);
    var ctx = cv.getContext('2d'), field = new Field(Wd, Ht, 10), dots = {}, labs = {}, edgeEls = [];

    function isEx(id) { return !!ex[id]; }
    function R(id) { return ex[id] ? B.R(ex[id].age + T, ex[id].S) : 0; }
    function frontier() { var f = {}; edges.forEach(function (e) { if (isEx(e[0]) && !isEx(e[1])) f[e[1]] = 1; if (isEx(e[1]) && !isEx(e[0])) f[e[0]] = 1; }); return f; }
    function nextFocus() { var F = frontier(); for (var i = 0; i < order.length; i++) if (F[order[i]]) return order[i]; return null; }
    function targets() {
      var F = frontier(), gF = num('--mist-focus', 0.6), gG = num('--mist-glimpse', 0.42);
      nodes.forEach(function (n) { var r = R(n.id); n.R = r; n.wT = isEx(n.id) ? r : 0; n.rT = isEx(n.id) ? B.sight(ex[n.id].S) : 0; n.gT = F[n.id] ? (n.id === focus ? gF : gG) : 0; });
    }
    function curve(a, b) { var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), s = ((a.x + b.y) % 3) ? 1 : -1, k = 0.07 * L * s; return 'M' + a.x + ' ' + a.y + ' Q' + (mx - dy / L * k).toFixed(1) + ' ' + (my + dx / L * k).toFixed(1) + ' ' + b.x + ' ' + b.y; }
    function build() {
      terr.innerHTML = ''; dots = {}; labs = {}; edgeEls = [];
      var vertical = texture() === 'ink';
      (cfg.regions || []).forEach(function (rg) {
        var t = el('text', { x: rg.x, y: rg.y, 'class': 'region' }, terr);
        if (vertical) rg.label.replace(/\s/g, '').split('').forEach(function (ch, i) { el('tspan', { x: rg.x, dy: i ? '1.25em' : '0' }, t).textContent = ch; });
        else t.textContent = rg.label;
      });
      var eg = el('g', {}, terr);
      edges.forEach(function (e) { var p = el('path', { d: curve(by[e[0]], by[e[1]]), 'class': 'edge' }, eg); p._e = e; edgeEls.push(p); });
      nodes.forEach(function (n) { dots[n.id] = el('circle', { cx: n.x, cy: n.y, r: 5, 'class': 'dot' }, terr); var t = el('text', { x: n.x + 11, y: n.y + 5, 'class': 'lab' }, terr); t.textContent = n.label; labs[n.id] = t; });
      worlds.forEach(function (w) { el('ellipse', { cx: w.x, cy: w.y, rx: w.r * 0.86, ry: w.r * 0.62, 'class': 'world' }, terr); });
    }
    function paintTerrain() {
      var F = frontier();
      nodes.forEach(function (n) {
        var d = dots[n.id], l = labs[n.id];
        if (isEx(n.id)) { d.setAttribute('class', 'dot ex'); d.style.fill = 'var(--ink-' + B.level(n.R) + ')'; l.setAttribute('class', 'lab ex' + (n.R < 0.4 ? ' faint' : '')); }
        else { d.setAttribute('class', 'dot ' + (F[n.id] ? 'fr' : 'hid')); d.style.fill = ''; l.setAttribute('class', 'lab'); }
      });
      edgeEls.forEach(function (p) { p.setAttribute('class', 'edge' + (isEx(p._e[0]) && isEx(p._e[1]) ? ' trod' : '')); });
    }
    function overlay() {
      over.innerHTML = ''; var F = frontier();
      worlds.forEach(function (w) {
        var reached = w.adj && isEx(w.adj), g = el('g', { 'class': 'world-g' + (reached ? ' on' : '') }, over);
        el('text', { x: w.x, y: w.y + 5, 'text-anchor': 'middle', 'class': 'world-lab' }, g).textContent = w.label || '未测绘';
        if (reached) { var h = el('g', { 'class': 'hit', tabindex: '0', role: 'button', 'aria-label': (w.label || '未测绘') + '的区域' }, over); el('circle', { cx: w.x, cy: w.y, r: w.r * 0.6 }, h); press(h, function () { sel = null; overlay(); if (cfg.onSelect) cfg.onSelect({ node: w, state: 'world', R: 0 }); }); }
      });
      if (focus && by[focus]) { var fn = by[focus]; el('circle', { cx: fn.x, cy: fn.y, r: 10, 'class': 'focus' }, over); }
      if (sel && by[sel]) { var sn = by[sel]; el('circle', { cx: sn.x, cy: sn.y, r: 14, 'class': 'sel' }, over); }
      nodes.forEach(function (n) {
        if (!isEx(n.id) && !F[n.id]) return;
        var g = el('g', { 'class': 'hit', tabindex: '0', role: 'button', 'aria-label': n.label + (isEx(n.id) ? '，已探索' : '，前沿') }, over);
        el('circle', { cx: n.x + n.lw / 2, cy: n.y, r: Math.max(24, n.lw / 2 + 6) }, g);
        press(g, function () { sel = n.id; overlay(); if (cfg.onSelect) cfg.onSelect({ node: n, state: isEx(n.id) ? 'explored' : 'frontier', R: n.R, days: isEx(n.id) ? Math.max(0, Math.round(ex[n.id].age + T)) : null }); });
      });
    }
    function draw() {
      ctx.clearRect(0, 0, Wd, Ht);
      var src = nodes.map(function (n) { return { x: n.x, y: n.y, w: n.w, r: n.r }; });
      var gl = nodes.map(function (n) { return { x: n.x + n.lw / 2 + 4, y: n.y, w: n.g, rx: 76, ry: 40 }; });
      field.paint(ctx, Wd, Ht, src, gl, worlds);
    }
    var kick = Tween(function () { return nodes; }, ['w', 'r', 'g'], draw);
    function update() { targets(); paintTerrain(); overlay(); }
    function pulse() {
      if (reduced() || !focus || !by[focus]) return;
      var n = by[focus], c = el('circle', { cx: n.x, cy: n.y, r: 10, 'class': 'pulse' }, over);
      c.animate([{ transform: 'scale(1)', opacity: 0.9 }, { transform: 'scale(3)', opacity: 0 }], { duration: num('--dur-settle', 1800), easing: css('--ease-mist', 'ease-out'), fill: 'forwards' }).finished.then(function () { c.remove(); }, function () {});
    }
    build(); targets();
    nodes.forEach(function (n) { n.w = n.wT; n.r = n.rT; n.g = n.id === focus ? 0 : n.gT; });
    paintTerrain(); overlay(); draw();
    setTimeout(function () { kick(); pulse(); }, reduced() ? 0 : 600);
    onTheme(function () { field.tex = ''; build(); paintTerrain(); draw(); });

    return {
      explore: function (id, S) { if (!by[id]) return; ex[id] = { S: S || 3, age: -T }; if (focus === id) focus = nextFocus(); update(); kick(); },
      review: function (id, ok) { var e = ex[id]; if (!e) return; e.S = ok ? e.S * 2.5 : Math.max(2, e.S * 0.6); e.age = -T; update(); kick(); },
      setTime: function (days) { T = days; update(); kick(); },
      setFocus: function (id) { focus = id; update(); kick(); },
      deselect: function () { sel = null; overlay(); },
      frontier: function () { return Object.keys(frontier()); },
      explored: function () { return Object.keys(ex); },
      fogged: function () { return Object.keys(ex).filter(function (id) { return R(id) < 0.4; }); },
      get focus() { return focus; },
      R: R
    };
  };
})();

/* Boyun.theme({ reg, day, fallback, key }): wires the 笔墨 / 昼夜 switch (two .by-seg groups with button[data-v]).
   Follows the system light/dark until the reader picks; remembers the pick in localStorage. */
(function () {
  var B = window.Boyun, root = document.documentElement;
  B.theme = function (o) {
    o = o || {};
    var key = o.key || 'boyun-theme', reg0 = o.fallback || 'cn', mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null, chosen = null;
    try { var s = localStorage.getItem(key); if (/^(cn|mod)-(light|dark)$/.test(s || '')) chosen = s; } catch (e) {}
    function sysDay() { return mq && mq.matches ? 'dark' : 'light'; }
    function cur() { return (root.getAttribute('data-theme') || (reg0 + '-' + sysDay())).split('-'); }
    function sync() { var c = cur(); [[o.reg, 0], [o.day, 1]].forEach(function (p) { if (!p[0]) return; [].slice.call(p[0].querySelectorAll('button[data-v]')).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-v') === c[p[1]] ? 'true' : 'false'); }); }); }
    function apply(t) { root.setAttribute('data-theme', t); sync(); }
    function choose(i, v) { var c = cur(); c[i] = v; chosen = c.join('-'); try { localStorage.setItem(key, chosen); } catch (e) {} apply(chosen); }
    apply(chosen || (reg0 + '-' + sysDay()));
    if (mq) mq.addEventListener('change', function () { if (!chosen) apply(cur()[0] + '-' + sysDay()); });
    [[o.reg, 0], [o.day, 1]].forEach(function (p) { if (p[0]) p[0].addEventListener('click', function (e) { var b = e.target.closest('button[data-v]'); if (b) choose(p[1], b.getAttribute('data-v')); }); });
    return { set: function (t) { chosen = t; try { localStorage.setItem(key, t); } catch (e) {} apply(t); }, get: function () { return cur().join('-'); } };
  };
})();
