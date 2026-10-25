// player.js — 配音动画播放器
//
// 场景作者（media agent）只需要写 setup() 和 seek(t)：
//
//   <link rel="stylesheet" href="/assets/player.css">
//   <div id="stage"> …SVG（viewBox="0 0 1280 720"）/ HTML / canvas… </div>
//   <script type="module">
//     import { mountScene, ease, lerp } from '/assets/player.js';
//     mountScene({
//       setup({ stage, ctx }) { /* 只执行一次：建 DOM、three.js 场景等 */ },
//       seek(t, ctx) { /* 纯函数：把画面画成时刻 t 的样子 */ },
//       resize({ width, height }) { /* 可选：舞台尺寸变化（像素） */ },
//     });
//   </script>
//
// 规则：
// - seek(t) 必须是确定性的：同一个 t 永远画出同一帧，不依赖上一帧的状态。
//   拖动进度条、倍速、reviewer 截图、以后导出 mp4 都依赖这一点。
// - 动画锚定在 beat 上，不写死秒数：ctx.p('terms', t, { at: 0.3, dur: 0.6 })。
// - t=0 的画面就是封面（播放前显示），要能独立成立。
// - 音频和时间轴默认取同目录的 audio.mp3 / timeline.json；URL 加 ?media=<目录>/ 可以换一套配音。
// - 无配音模式：timeline.json 的 provider 是 "silent"（没有 TTS key 时 tts.mjs 自动生成）就不加载音频，
//   用一个和 <audio> 接口相同的时钟（SilentClock）驱动画面，字幕始终打开。
//   默认用浏览器朗读字幕（Narrator，Web Speech API），时钟跟着读到哪句走；播放器里可以关，选择记在浏览器里。
// - QA 钩子：window.__LH.seekBeat('terms', 0.5) 后截图，即可检查任意时刻的画面。

import { log } from './lh-log.js';
import { applyTheme } from './lh-theme.js';

// 先加载主题的 player.css（/assets/themes/<主题>/）；场景脚本在这之后才运行
await applyTheme('player.css');

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, p) => a + (b - a) * p;
export const ease = {
  linear: x => x,
  in: x => x * x * x,
  out: x => 1 - (1 - x) ** 3,
  inOut: x => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  back: x => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2,
};

const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

// 无配音时代替 <audio>：只实现播放器用到的部分（currentTime、paused、ended、playbackRate、play/pause 和三个事件）。
// 开着浏览器朗读时，时钟只在 Narrator 给的窗口 [lo, hi] 里按正常速度走：落在 lo 前面（读得比估算的快）就 3 倍速追，
// 走到 hi（读得慢）就停住等；到了 hi 有 onReach 就调用它。
class SilentClock extends EventTarget {
  constructor(duration) {
    super();
    this.duration = duration;
    this.paused = true;
    this.narrator = null;
    this._rate = 1;
    this._t = 0;
    this._since = 0;
    this._timer = 0;
    this._lo = -Infinity;
    this._hi = Infinity;
    this._onReach = null;
  }
  get currentTime() {
    if (this.paused) return this._t;
    const dt = ((performance.now() - this._since) / 1000) * this._rate;
    const t = this._t, hi = Math.min(this._hi, this.duration);
    if (t >= hi) return t;
    const fast = Math.max(0, this._lo - t) / 3; // 追到 lo 要用掉的 dt
    return dt <= fast ? t + dt * 3 : Math.min(hi, Math.max(t, this._lo) + dt - fast);
  }
  set currentTime(t) {
    this._t = clamp(t, 0, this.duration);
    this._since = performance.now();
    if (!this.paused) this._go(true);
  }
  get ended() { return this.currentTime >= this.duration; }
  get playbackRate() { return this._rate; }
  set playbackRate(r) {
    this._commit();
    this._rate = r;
    if (!this.paused) this._schedule();
  }
  _commit() {
    if (!this.paused) { this._t = this.currentTime; this._since = performance.now(); }
  }
  setWindow(lo, hi, onReach = null) {
    this._commit();
    this._lo = lo;
    this._hi = hi;
    this._onReach = onReach;
    if (!this.paused) this._schedule();
  }
  setNarrator(n) {
    this.narrator?.stop();
    this.narrator = n;
    this.setWindow(-Infinity, Infinity);
    if (!this.paused) this._go();
  }
  // 开始走（播放、播放中拖动）：有朗读就交给它从当前位置读起
  _go(seek = false) {
    if (this.narrator) this.narrator.start(seek);
    else this._schedule();
  }
  _schedule() {
    clearTimeout(this._timer);
    const end = Math.min(this._hi, this.duration);
    const done = end === this.duration ? () => this._end() : this._onReach;
    if (!done) return;
    const t = this._t, fast = Math.max(0, Math.min(this._lo, end) - t);
    const ms = ((fast / 3 + Math.max(0, end - t - fast)) / this._rate) * 1000;
    this._timer = setTimeout(() => { this._commit(); done(); }, ms);
  }
  _end() {
    this._t = this.duration;
    this.paused = true;
    this.narrator?.stop();
    this.dispatchEvent(new Event('pause'));
    this.dispatchEvent(new Event('ended'));
  }
  play() {
    if (!this.paused) return Promise.resolve();
    if (this._t >= this.duration) this._t = 0;
    this._since = performance.now();
    this.paused = false;
    // 先发 play：播放器借这个事件暂停同页的其它动画（它们会停掉自己的朗读），然后才开始读
    this.dispatchEvent(new Event('play'));
    this._go();
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this._t = this.currentTime;
    this.paused = true;
    clearTimeout(this._timer);
    this.narrator?.stop();
    this.dispatchEvent(new Event('pause'));
  }
}

// 朗读时长的粗略权重，和 tools/tts.mjs 的 weight 一致：汉字 1，英文单词 1.6，数字 0.7
function weight(s) {
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const words = (s.match(/[A-Za-z]+/g) || []).length;
  const digits = (s.match(/\d/g) || []).length;
  return Math.max(0.5, cjk + words * 1.6 + digits * 0.7);
}

// 按句切开朗读：Chrome 的在线声音一次读太长（约 15 秒）会断。过长的句子再按逗号切。
function splitSpeech(text, max = 40) {
  const out = [];
  for (const sentence of text.match(/[^。！？!?；;\n]+[。！？!?；;]*[”’」』）)]*/g) || [text]) {
    if (weight(sentence) <= max) { out.push(sentence); continue; }
    let buf = '';
    for (const piece of sentence.match(/[^，,、：:]+[，,、：:]*/g) || [sentence]) {
      if (buf && weight(buf + piece) > max) { out.push(buf); buf = piece; } else buf += piece;
    }
    if (buf) out.push(buf);
  }
  const parts = out.map(s => s.trim()).filter(s => /[\p{L}\p{N}]/u.test(s));
  return parts.length ? parts : [text];
}

// 选声音：普通话（大陆优先，不用粤语），在线的自然人声优先（Edge 的 "Online (Natural)"、Chrome 的 Google 普通话），
// 没有就用系统自带的中文声音。双人对话的第二个声音要同一档的另一个，没有就同一个声音读（字幕颜色照样分开）。
function pickVoices(list) {
  const score = v =>
    (/^(zh|cmn)[-_](Hans[-_])?CN$/i.test(v.lang) ? 8 : /CN|Hans/i.test(v.lang) ? 6 : 4) +
    (/natural|premium|enhanced/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1) +
    (/xiaoxiao|晓晓/i.test(v.name) ? 0.5 : /yunxi\b|云希/i.test(v.name) ? 0.25 : 0);
  const zh = list.filter(v => /^(zh|cmn)([-_]|$)/i.test(v.lang) && !/HK|yue/i.test(v.lang)).sort((x, y) => score(y) - score(x));
  if (!zh.length) return null;
  const [a, b] = zh;
  return { a, b: b && Math.floor(score(b)) === Math.floor(score(a)) ? b : a };
}

// 浏览器朗读（Web Speech API）：字幕版的免费配音。每个 beat 按句排进朗读队列，读到哪句，时钟就在那句的时间范围里走；
// beat 之间照常停顿。暂停、拖动时取消，继续播放时从当前这句的开头重读。
class Narrator {
  constructor(clock, timeline) {
    this.clock = clock;
    this.speed = timeline.speed || 1;
    this.voices = null;
    this.onFail = null;
    this.units = []; // 每句：beat 序号、估算的时间范围、要读的文字
    timeline.beats.forEach((b, beat) => {
      const parts = splitSpeech(b.say ?? b.text);
      const ws = parts.map(weight);
      const total = ws.reduce((x, y) => x + y, 0);
      let t = b.start;
      parts.forEach((text, i) => {
        const d = ((b.end - b.start) * ws[i]) / total;
        this.units.push({ beat, start: t, end: t + d, text, speaker: b.speaker });
        t += d;
      });
    });
    this._gen = 0; // 每次 stop 加一：旧的朗读事件晚到时认得出来，不再理会
    this._dog = 0;
    this._live = [];
  }
  // 返回有没有能用的声音。在线声音出过错（offline）以后只用系统自带的
  setVoices(list) {
    this._list = list;
    const v = pickVoices(this.offline ? list.filter(x => x.localService) : list);
    if (v) this.voices = v;
    return !!v;
  }
  stop() {
    this._gen++;
    clearTimeout(this._dog);
    this._live = [];
    speechSynthesis.cancel();
  }
  // 从时钟的位置读起。播放、打开朗读：在一句中间就退回句首重读（停在句尾等朗读时暂停的，也重读这句）。
  // 播放中拖动、快进（seek）：落在一句的后半就从下一句读起，免得往回跳
  start(seek = false) {
    this.stop();
    const gen = this._gen, c = this.clock;
    let k = this.units.findIndex(u => c._t <= u.end);
    if (seek && k >= 0 && c._t > (this.units[k].start + this.units[k].end) / 2) c._t = this.units[k++].end;
    c._since = performance.now();
    const u = this.units[k];
    if (!u) return c.setWindow(-Infinity, Infinity); // 最后一句之后：照常走到结尾
    if (c._t < u.start) return this._wait(k, gen); // 在 beat 之间的停顿里
    c._t = u.start;
    this._speak(k, gen);
  }
  // 时钟走到第 k 句的开头再读（beat 之间的停顿）；上一句读得快，就先追到上一句的结尾
  _wait(k, gen) {
    this.clock.setWindow(k ? this.units[k - 1].end : -Infinity, this.units[k].start, () => gen === this._gen && this._speak(k, gen));
  }
  // 读第 k 句。一句一句地排：倍速、换声音从下一句起就生效
  _speak(k, gen) {
    const c = this.clock, u = this.units[k], next = this.units[k + 1];
    c.setWindow(u.start, u.start); // 真的开始读之前，画面停在句首等
    const ut = new SpeechSynthesisUtterance(u.text);
    clearTimeout(this._dog);
    this._dog = setTimeout(() => this._error(k, gen, ut.voice, 'timeout'), 8000); // 一直不开始就当读不出来
    ut.voice = u.speaker === 'b' ? this.voices.b : this.voices.a;
    ut.lang = ut.voice.lang;
    ut.rate = c.playbackRate * this.speed;
    ut.onstart = () => {
      if (gen !== this._gen) return;
      clearTimeout(this._dog);
      c.setWindow(u.start, u.end);
    };
    ut.onend = () => {
      if (gen !== this._gen) return;
      if (!next) c.setWindow(u.end, Infinity); // 读完最后一句：走到结尾
      else if (next.beat === u.beat || document.hidden) this._speak(k + 1, gen); // 同一个 beat 接着读；页面在后台时定时器会被限流，也直接读
      else this._wait(k + 1, gen); // beat 之间照常停顿
    };
    ut.onerror = e => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') this._error(k, gen, ut.voice, e.error);
    };
    this._live = [ut]; // 留着引用：Chrome 会回收没人引用的 utterance，之后的事件就收不到了
    speechSynthesis.speak(ut);
  }
  // 读不出来：在线声音（比如断网时）先换系统自带的声音重读这句，还不行就回到静音字幕版
  _error(k, gen, voice, reason) {
    if (gen !== this._gen) return;
    if (!voice.localService && !this.offline) {
      this.offline = true;
      if (this.setVoices(this._list)) {
        this.stop();
        return this._speak(k, this._gen);
      }
    }
    this._fail(reason);
  }
  _fail(reason) {
    if (this.clock.narrator !== this) return;
    this.clock.setNarrator(null);
    this.onFail?.(reason);
  }
}

// 浏览器的声音列表：Chrome、Edge 要等 voiceschanged 才有，最多等 2 秒
function loadVoices() {
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve([]);
  if (synth.getVoices().length) return Promise.resolve(synth.getVoices());
  return new Promise(resolve => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 2000);
  });
}

function makeCtx(timeline) {
  const beats = timeline.beats;
  const byId = new Map(beats.map((b, i) => [b.id, { ...b, index: i, next: beats[i + 1]?.start ?? timeline.duration }]));
  const beat = id => {
    const b = byId.get(id);
    if (!b) throw new Error(`timeline 里没有 beat "${id}"（现有：${beats.map(x => x.id).join(', ')}）`);
    return b;
  };
  return {
    width: 1280,
    height: 720,
    timeline,
    duration: timeline.duration,
    beats,
    beat,
    /** 锚定在 beat 上的动画进度 0→1（已缓动）。at：在 beat 语音中的位置比例 0–1；delay：额外秒数；dur：动画时长（秒） */
    p(id, t, { at = 0, delay = 0, dur = 0.8, ease: e = ease.inOut } = {}) {
      const b = beat(id);
      const start = b.start + at * (b.end - b.start) + delay;
      return e(clamp((t - start) / dur));
    },
    /** beat 内的线性进度 0→1（从该 beat 开始到下一个 beat 开始） */
    span(id, t) {
      const b = beat(id);
      return clamp((t - b.start) / (b.next - b.start));
    },
    /** 是否处在这个 beat 里（含其后的停顿） */
    active(id, t) {
      const b = beat(id);
      return t >= b.start && t < b.next;
    },
    /** 可见度 0→1：在 from 开始时淡入，在 until 开始时淡出（until 省略则一直可见） */
    visible(t, from, until, fade = 0.4) {
      const fin = clamp((t - beat(from).start) / fade);
      const fout = until ? 1 - clamp((t - beat(until).start) / fade) : 1;
      return Math.min(fin, fout);
    },
    /** 当前 beat 的 id */
    current(t) {
      let cur = beats[0]?.id;
      for (const b of beats) if (t >= b.start) cur = b.id;
      return cur;
    },
  };
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export async function mountScene(scene, opts = {}) {
  const errors = [];
  const params = new URLSearchParams(location.search);
  const base = new URL(params.get('media') || opts.media || './', location.href);
  const mediaId = base.pathname.replace(/\/$/, '').split('/').slice(-2).join('/');

  // ---- DOM ----
  const stage = document.getElementById('stage') || el('div');
  stage.id = 'stage';
  const root = el('div', 'lh-player');
  root.tabIndex = 0;
  const frame = el('div', 'lh-frame');
  const cc = el('div', 'lh-cc');
  const ccText = el('span');
  cc.append(ccText);
  const big = el('button', 'lh-big');
  big.title = '播放（空格）';
  const controls = el('div', 'lh-controls');
  const playBtn = el('button', 'lh-play', '▶');
  const time = el('span', 'lh-time', '0:00 / 0:00');
  const bar = el('div', 'lh-bar');
  const fill = el('div', 'lh-fill');
  const speedBtn = el('button', 'lh-speed', '1×');
  const ccBtn = el('button', 'lh-ccbtn', '字幕');
  const fsBtn = el('button', 'lh-fs', '⛶');
  playBtn.title = '播放/暂停（空格）';
  speedBtn.title = '倍速';
  ccBtn.title = '字幕开关（C）';
  fsBtn.title = '全屏（F）';
  bar.append(fill);
  controls.append(playBtn, time, bar, speedBtn, ccBtn, fsBtn);
  // 导出过 mp4（tools/render-video.mjs）就显示下载入口
  const video = new URL('video.mp4', base);
  fetch(`/api/exists?path=${encodeURIComponent(video.pathname)}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).then(r => {
    if (!r.exists) return;
    const dl = el('a', 'lh-dl', 'mp4');
    dl.href = video.href;
    dl.download = `${base.pathname.split('/').filter(x => x && x !== 'lessons' && x !== 'media').join('-')}.mp4`; // 如 <topic>-w00-d0-one-request.mp4
    dl.title = '下载这段动画的 mp4（带字幕）';
    dl.addEventListener('click', e => e.stopPropagation());
    fsBtn.before(dl);
  }).catch(() => {});
  frame.append(stage, cc, big, controls);
  root.append(frame);
  document.body.append(root);

  const showError = msg => {
    console.error(`[LH player] ${msg}`);
    errors.push(msg);
    if (!frame.querySelector('.lh-error')) frame.append(el('div', 'lh-error'));
    frame.querySelector('.lh-error').textContent = errors.join('\n');
  };
  window.addEventListener('error', e => errors.push(String(e.message)));

  // ---- 数据 ----
  let timeline;
  try {
    const res = await fetch(new URL('timeline.json', base));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    timeline = await res.json();
  } catch (e) {
    showError(`时间轴加载失败：${new URL('timeline.json', base).pathname}（${e.message}）`);
    return;
  }
  const ctx = makeCtx(timeline);
  const duration = timeline.duration;
  const silent = timeline.provider === 'silent';
  let audio;
  if (silent) {
    audio = new SilentClock(duration);
    root.classList.add('silent');
    playBtn.title = '播放/暂停（空格）：这段动画没有配音，看字幕';
  } else {
    audio = new Audio(new URL('audio.mp3', base));
    audio.preload = 'auto';
    audio.addEventListener('error', () => showError(`音频加载失败：${new URL('audio.mp3', base).pathname}`));
  }

  for (const b of timeline.beats) {
    const tick = el('div', 'lh-tick');
    tick.style.left = `${(b.start / duration) * 100}%`;
    tick.title = b.id;
    bar.append(tick);
  }

  // ---- 尺寸 ----
  const onResize = () => {
    const w = frame.clientWidth, h = frame.clientHeight;
    frame.style.setProperty('--u', `${w / 1280}px`);
    try { scene.resize?.({ width: w, height: h }); } catch (e) { showError(`resize 出错：${e.message}`); }
  };

  try {
    await scene.setup?.({ stage, ctx, timeline });
  } catch (e) {
    showError(`setup 出错：${e.message}`);
    return;
  }
  new ResizeObserver(onResize).observe(frame);
  onResize();

  // ---- 渲染 ----
  let seekFailed = false;
  function render(t) {
    t = clamp(t, 0, duration);
    try { scene.seek(t, ctx); } catch (e) {
      if (!seekFailed) showError(`seek(${t.toFixed(2)}) 出错：${e.message}`);
      seekFailed = true;
    }
    const cue = timeline.cues?.find(c => t >= c.start && t < c.end);
    const text = cue ? cue.text : '';
    if (ccText.textContent !== text) ccText.textContent = text;
    ccText.classList.toggle('b', cue?.speaker === 'b'); // 双人对话：第二个声音的字幕换个颜色
    const atEnd = t >= duration - 0.05;
    root.classList.toggle('at-start', t < 0.05);
    root.classList.toggle('at-end', atEnd);
    const label = atEnd ? 'end' : 'start';
    if (big.dataset.state !== label) {
      big.dataset.state = label;
      big.innerHTML = atEnd
        ? '<span class="ico">↻</span>重播'
        : `<span class="ico">▶</span>播放<span class="t">${fmt(duration)}</span>`;
    }
    fill.style.width = `${(t / duration) * 100}%`;
    time.textContent = `${fmt(t)} / ${fmt(duration)}`;
  }

  // ---- 播放统计（用于了解学习习惯） ----
  let played = 0, lastT = 0, maxT = 0;
  const report = type => log(type, { media: mediaId, t: +audio.currentTime.toFixed(1), played: Math.round(played), max: +maxT.toFixed(1), duration });

  let raf = 0, scrubbing = false;
  function loop() {
    const t = audio.currentTime;
    const dt = t - lastT;
    if (dt > 0 && dt < 0.5) played += dt;
    lastT = t;
    maxT = Math.max(maxT, t);
    render(t);
    if (!audio.paused) raf = requestAnimationFrame(loop);
  }

  audio.addEventListener('play', () => {
    root.classList.add('playing');
    playBtn.textContent = '❚❚';
    lastT = audio.currentTime;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    if (!scrubbing) report('media_play');
    // 同一页面里的其它播放器（兄弟 iframe）自动暂停，避免声音叠在一起
    if (window.parent !== window) {
      const frames = window.parent.frames;
      for (let i = 0; i < frames.length; i++) {
        try { if (frames[i] !== window) frames[i].__LH?.pause(); } catch { /* 跨源 iframe 访问不了，忽略 */ }
      }
    }
  });
  audio.addEventListener('pause', () => {
    root.classList.remove('playing');
    playBtn.textContent = '▶';
    render(audio.currentTime);
    if (!scrubbing && !audio.ended) report('media_pause');
  });
  audio.addEventListener('ended', () => {
    render(duration);
    report('media_ended');
  });
  window.addEventListener('pagehide', () => { if (played > 0) report('media_progress'); });

  const toggle = () => (audio.paused ? audio.play().catch(e => showError(`无法播放：${e.message}`)) : audio.pause());
  function setTime(t) {
    t = clamp(t, 0, duration);
    audio.currentTime = Math.min(t, Number.isFinite(audio.duration) ? audio.duration : t);
    lastT = t;
    render(t);
  }

  big.addEventListener('click', toggle);
  playBtn.addEventListener('click', toggle);
  stage.addEventListener('click', toggle);

  // 进度条拖动
  let wasPlaying = false;
  const seekFromPointer = e => {
    const r = bar.getBoundingClientRect();
    setTime(((e.clientX - r.left) / r.width) * duration);
  };
  bar.addEventListener('pointerdown', e => {
    scrubbing = true;
    wasPlaying = !audio.paused;
    bar.setPointerCapture(e.pointerId);
    audio.pause();
    seekFromPointer(e);
  });
  bar.addEventListener('pointermove', e => { if (scrubbing) seekFromPointer(e); });
  bar.addEventListener('pointerup', () => {
    scrubbing = false;
    report('media_seek');
    if (wasPlaying) audio.play();
  });

  // 倍速（全局偏好，跨课程记住）
  const applySpeed = s => {
    audio.playbackRate = s;
    speedBtn.textContent = `${s}×`;
    localStorage.setItem('lh.speed', String(s));
  };
  applySpeed(SPEEDS.includes(Number(localStorage.getItem('lh.speed'))) ? Number(localStorage.getItem('lh.speed')) : 1);
  speedBtn.addEventListener('click', () => {
    applySpeed(SPEEDS[(SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length]);
    log('media_speed', { media: mediaId, speed: audio.playbackRate });
  });

  // 字幕开关（全局偏好；只有学习者自己点开关才改偏好，打开一段无配音动画不会把关掉的字幕偏好改回"开"）
  const applyCc = (on, save = true) => {
    root.classList.toggle('cc-off', !on);
    ccBtn.classList.toggle('on', on);
    if (save) localStorage.setItem('lh.cc', on ? '1' : '0');
  };
  applyCc(silent || localStorage.getItem('lh.cc') !== '0', false);
  if (silent) ccBtn.hidden = true; // 没有配音时字幕就是全部内容，不让关
  else ccBtn.addEventListener('click', () => applyCc(root.classList.contains('cc-off')));

  // 浏览器朗读（只在无配音时；默认开，全局偏好）。浏览器没有中文声音就不显示开关，保持静音字幕版
  if (silent && window.speechSynthesis) {
    const narrator = new Narrator(audio, timeline);
    const ttsBtn = el('button', 'lh-ccbtn lh-ttsbtn', '朗读');
    ttsBtn.hidden = true;
    ccBtn.after(ttsBtn);
    const applyTts = (on, save = true) => {
      audio.setNarrator(on ? narrator : null);
      ttsBtn.classList.toggle('on', on);
      ttsBtn.title = on ? `浏览器朗读：${narrator.voices.a.name}（点一下关掉）` : '浏览器朗读（点一下打开）';
      playBtn.title = on ? '播放/暂停（空格）' : '播放/暂停（空格）：这段动画没有配音，看字幕';
      if (save) localStorage.setItem('lh.tts', on ? '1' : '0');
    };
    narrator.onFail = reason => {
      applyTts(false, false);
      ttsBtn.title = `朗读出错（${reason}），先看字幕；点一下重试`;
    };
    ttsBtn.addEventListener('click', () => {
      applyTts(!ttsBtn.classList.contains('on'));
      log('media_tts', { media: mediaId, on: ttsBtn.classList.contains('on') });
    });
    // Edge 的在线声音可能晚一点才加进列表：每次列表变化都重新挑，下一句起生效
    const onVoices = list => {
      if (!narrator.setVoices(list) || !ttsBtn.hidden) return;
      ttsBtn.hidden = false;
      applyTts(localStorage.getItem('lh.tts') !== '0', false);
    };
    loadVoices().then(onVoices);
    speechSynthesis.addEventListener('voiceschanged', () => onVoices(speechSynthesis.getVoices()));
    window.addEventListener('pagehide', () => speechSynthesis.cancel());
  }

  // 全屏（嵌在 iframe 里时需要 allow="fullscreen"）
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.().catch(() => {}));
  fsBtn.addEventListener('click', toggleFs);

  // 键盘
  document.addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') toggle();
    else if (k === 'arrowleft') setTime(audio.currentTime - 5);
    else if (k === 'arrowright') setTime(audio.currentTime + 5);
    else if (k === 'c' && !silent) applyCc(root.classList.contains('cc-off'));
    else if (k === 'f') toggleFs();
    else return;
    e.preventDefault();
  });

  // 播放中鼠标静止 2 秒后隐藏控制条
  let idleTimer = 0;
  root.addEventListener('pointermove', () => {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => root.classList.add('idle'), 2000);
  });

  render(0);

  // ---- QA 钩子 ----
  window.__LH = {
    ready: true,
    duration,
    silent,
    beats: timeline.beats.map(b => b.id),
    errors,
    seek: t => (setTime(t), t),
    seekBeat(id, frac = 0.5) {
      const b = ctx.beat(id);
      const t = b.start + frac * (b.end - b.start);
      setTime(t);
      return +t.toFixed(3);
    },
    play: () => audio.play(),
    pause: () => audio.pause(),
    tts: () => audio.narrator?.voices.a.name ?? null, // 正在用的朗读声音；没开朗读是 null
  };
  document.dispatchEvent(new CustomEvent('lh:ready'));
  return window.__LH;
}
