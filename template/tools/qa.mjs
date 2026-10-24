#!/usr/bin/env node
// qa.mjs — 课程页技术 QA（reviewer 用）：用本机 Chrome / Edge 的 headless 模式，一条命令完成检查 + 截图
//
// 用法：node tools/qa.mjs <课程路径> [--out <目录>]
//   例：node tools/qa.mjs lessons/<topic>/w00/d0
//   只测一个组件：node tools/qa.mjs lessons/<topic>/w00/d0/viz/token-cost.html
//                 node tools/qa.mjs lessons/<topic>/w00/d0/media/flow
//   （开头不要加 /：Git Bash 会把 /lessons/... 改写成 Windows 路径。也接受 site/lessons/... 这样的文件路径）
//
// 检查：控制台报错、插槽是否全部填充（MISSING）、lesson.js 警告（缺 data-min、小测 answer 不在选项里等）、
//       每个配音动画和交互组件自身的报错、交互组件内容是否被 iframe 截断。
// 截图（默认 .tmp/qa/<课程路径>/，用 Read 查看）：
//   page-top.png（1440×900 首屏）、page.png（整页 1440 宽）、page-narrow.png（820 宽）、sec-<id>.png（每段）、
//   media-<id>-00-cover.png + media-<id>-<序号>-<beat>.png（每个 beat 70% 处）、viz-<id>.png
// 结果写入 report.json；有错误时退出码为 1。服务器没开会自动临时启动。

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT) || 4321;
const ORIGIN = `http://localhost:${PORT}`;

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.log('用法：node tools/qa.mjs <课程路径，如 lessons/<topic>/w00/d0> [--out <目录>]'); process.exit(1); }
let lessonPath = '/' + target.replaceAll('\\', '/')
  .replace(/^https?:\/\/[^/]+/, '')
  .replace(/^[A-Za-z]:\/.*?\/Git\//, '')   // Git Bash 改写过的 /xxx
  .replace(/^(.*\/)?site\//, '')           // 文件路径 site/lessons/...
  .replace(/^\/+/, '').replace(/index\.html$/, '').replace(/\/?$/, '/');
// 只测单个组件：…/viz/<id>.html 或 …/media/<id>（课程页还没写好时，viz/media 自测用）
let only = null;
const comp = lessonPath.match(/^(.*\/)(viz)\/([\w-]+)\.html\/$/) || lessonPath.match(/^(.*\/)(media)\/([\w-]+)\/$/);
if (comp) { lessonPath = comp[1]; only = { kind: comp[2], id: comp[3] }; }

const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1]
  : path.join(ROOT, '.tmp', 'qa', ...lessonPath.split('/').filter(Boolean), ...(only ? [`${only.kind}-${only.id}`] : [])));
const fwd = p => p.replaceAll('\\', '/');

// 多个 agent 可能同时跑 QA：用锁文件排队，一次只开一个 headless 浏览器（省内存）
const LOCK = path.join(ROOT, '.tmp', 'qa.lock');
async function acquireLock() {
  await mkdir(path.dirname(LOCK), { recursive: true });
  for (let waited = false; ;) {
    try { await writeFile(LOCK, String(process.pid), { flag: 'wx' }); return; } catch {
      const st = statSync(LOCK, { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > 5 * 60_000) { await rm(LOCK, { force: true }); continue; } // 超过 5 分钟视为残留
      if (!waited) { console.log('另一个 QA 正在运行，排队等待…'); waited = true; }
      await sleep(1000);
    }
  }
}

// ---- 浏览器（CDP） ----
let chrome = null, page = null, vpWidth = 1440;
const consoleErrs = [];
async function openBrowser() {
  chrome = await launchChrome(path.join(ROOT, '.tmp', `qa-chrome-${process.pid}`));
  page = await chrome.newPage();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  const text = a => a.value ?? a.description ?? '';
  page.on('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'assert') consoleErrs.push(p.args.map(text).join(' ')); });
  page.on('Runtime.exceptionThrown', p => consoleErrs.push((p.exceptionDetails.exception?.description || p.exceptionDetails.text || '').split(/\r?\n/)[0]));
  // 浏览器自动请求的 /favicon.ico 不算课程的错误
  page.on('Log.entryAdded', p => { if (p.entry.level === 'error' && !(p.entry.url || '').endsWith('/favicon.ico')) consoleErrs.push(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`); });
}
async function viewport(width, height) {
  vpWidth = width;
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}
async function goto(url) {
  const loaded = page.once('Page.loadEventFired', 30000);
  await page.send('Page.navigate', { url });
  await loaded.catch(() => {});
}
// 在页面里执行表达式，表达式应返回 JSON 字符串（或返回它的 Promise）
async function evalJson(expr) {
  const v = await page.eval(expr);
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { throw new Error(`无法解析页面返回值：${v.slice(0, 300)}`); }
}
const waitFor = (cond, ms = 15000) =>
  `new Promise(r=>{const t0=Date.now();const w=()=>{let v;try{v=(${cond})}catch(e){}if(v||Date.now()-t0>${ms})r(JSON.stringify(v||null));else setTimeout(w,150)};w()})`;
const takeConsoleErrors = () => consoleErrs.splice(0);

// 截图：mode = 'viewport'（只截当前视口）| 'full'（整页）| 'selector'（一个元素）
async function capture(file, mode = 'full', selector) {
  const params = { format: 'png' };
  if (mode === 'full') {
    const m = await page.send('Page.getLayoutMetrics');
    const size = m.cssContentSize || m.contentSize;
    // 太长的页面会超出浏览器的纹理上限（约 16384px），截到上限为止；细节看分段截图
    Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.max(vpWidth, Math.ceil(size.width)), height: Math.min(16000, Math.ceil(size.height)), scale: 1 } });
  } else if (mode === 'selector') {
    const r = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'start' }); const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: Math.ceil(b.width), height: Math.min(16000, Math.ceil(b.height)) }; })()`);
    if (!r || !r.width || !r.height) throw new Error(`截图找不到元素：${selector}`);
    await sleep(100);
    Object.assign(params, { captureBeyondViewport: true, clip: { ...r, scale: 1 } });
  }
  const { data } = await page.send('Page.captureScreenshot', params);
  await writeFile(file, Buffer.from(data, 'base64'));
}

async function health() {
  try { return (await fetch(`${ORIGIN}/api/health`)).ok; } catch { return false; }
}

let server = null;
async function ensureServer() {
  if (await health()) return;
  server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs')], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40 && !(await health()); i++) await new Promise(r => setTimeout(r, 150));
  if (!(await health())) throw new Error('本地服务器启动失败');
}

const report = { lesson: lessonPath, time: new Date().toISOString(), errors: [], warnings: [], missing: [], est: 0, media: [], viz: [], screenshots: [] };
const err = (where, msg) => report.errors.push(`[${where}] ${msg}`);
const shot = async (file, mode, selector) => {
  const p = path.join(OUT, file);
  await capture(p, mode, selector);
  report.screenshots.push(fwd(p));
};

await acquireLock();
try {
  await ensureServer();
  await openBrowser();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 每次从干净状态开始（不带上次的小测答案、打卡），并打开 QA 标记：页面不往学习记录里写事件
  await goto(`${ORIGIN}/api/health`);
  await evalJson(`(localStorage.clear(), localStorage.setItem('lh:qa', '1'), JSON.stringify(true))`);

  if (only?.kind === 'media') {
    const tl = await fetch(`${ORIGIN}${lessonPath}media/${only.id}/timeline.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!tl) throw new Error(`media/${only.id}/timeline.json 不存在：先运行 node tools/tts.mjs`);
    report.media.push({ id: only.id, duration: tl.duration, beats: tl.beats.map(b => b.id) });
  } else if (only?.kind === 'viz') {
    report.viz.push({ id: only.id });
  }

  if (!only) {
    // ---- 1) 课程页 ----
    await viewport(1440, 900);
    takeConsoleErrors();
    await goto(`${ORIGIN}${lessonPath}`);
    const L = await evalJson(waitFor('window.__LESSON && window.__LESSON.ready && window.__LESSON'));
    if (!L) throw new Error('课程页没有就绪（window.__LESSON.ready 一直为 false）：检查 lesson.js 是否加载、页面结构是否正确');
    report.est = L.est;
    report.sections = L.sections;
    report.quizzes = L.quizzes;
    report.guesses = L.guesses;
    report.missing = L.slots.missing;
    report.warnings.push(...L.warnings.map(w => `[lesson] ${w}`));
    L.errors.forEach(e => err('lesson', e));
    L.slots.missing.forEach(m => err('lesson', `MISSING：${m}`));

    // 等 iframe 里的组件就绪，再收集它们自己的状态
    await evalJson(waitFor(`[...document.querySelectorAll('.lh-media iframe')].every(f=>f.contentWindow.__LH&&(f.contentWindow.__LH.ready||f.contentWindow.__LH.errors.length))`, 20000));
    await new Promise(r => setTimeout(r, 800)); // 给交互组件一点时间完成首次渲染和高度回报
    const frames = await evalJson(`JSON.stringify([...document.querySelectorAll('.lh-slot')].map(fig=>{const f=fig.querySelector('iframe');const w=f.contentWindow;const kind=fig.classList.contains('lh-media')?'media':'viz';
      const o={kind,id:fig.dataset.id,sec:fig.closest('section')?.dataset.sec};
      try{ if(kind==='media'){const P=w.__LH||{};o.ready=!!P.ready;o.errors=P.errors||['__LH 不存在'];o.duration=P.duration;o.beats=P.beats||[];}
        else{o.errors=(w.__LHC&&w.__LHC.errors)||['没有加载 /assets/component.js'];o.frameH=f.getBoundingClientRect().height;o.contentH=Math.ceil(w.document.body.getBoundingClientRect().height);}
      }catch(e){o.errors=['无法访问 iframe：'+e.message]} return o;}))`);
    for (const f of frames) {
      f.errors.forEach(e => err(`${f.kind}/${f.id}`, e));
      if (f.kind === 'media') {
        if (!f.ready) err(`media/${f.id}`, '播放器没有就绪');
        report.media.push({ id: f.id, sec: f.sec, duration: f.duration, beats: f.beats });
      } else {
        if (f.contentH > f.frameH + 4) err(`viz/${f.id}`, `内容被截断：内容高 ${f.contentH}px，iframe 只有 ${Math.round(f.frameH)}px（是否忘了加载 component.js，或给 html/body 设了 height:100%？）`);
        report.viz.push({ id: f.id, sec: f.sec, height: Math.round(f.frameH) });
      }
    }
    takeConsoleErrors().forEach(e => err('console', e));

    await shot('page-top.png', 'viewport'); // 首屏（1440×900）：整页截图太长会被缩小，看不清页首
    // 整页和分段截图时，固定在顶部的进度条和右下角按钮会停在页面中间、盖住内容，先让它们不再固定
    const unstick = () => evalJson(`(document.head.insertAdjacentHTML('beforeend','<style id="qa-unstick">.lh-top{position:relative!important}.lh-capture{display:none!important}</style>'), JSON.stringify(true))`);
    await unstick();
    await shot('page.png');
    for (const s of L.sections) await shot(`sec-${s.id}.png`, 'selector', `[data-sec="${s.id}"]`);
    await viewport(820, 1000);
    await goto(`${ORIGIN}${lessonPath}`);
    await evalJson(waitFor('window.__LESSON && window.__LESSON.ready'));
    await unstick();
    await shot('page-narrow.png');
  }

  // ---- 2) 每个配音动画：封面 + 每个 beat ----
  await viewport(1280, 720);
  for (const m of report.media) {
    takeConsoleErrors();
    await goto(`${ORIGIN}${lessonPath}media/${m.id}/scene.html`);
    const P = await evalJson(waitFor('window.__LH && (window.__LH.ready || window.__LH.errors.length) && {ready: window.__LH.ready, errors: window.__LH.errors}'));
    if (!P?.ready) { err(`media/${m.id}`, `单独打开时没有就绪：${P?.errors?.join('; ') ?? '超时'}`); continue; }
    await evalJson('JSON.stringify(window.__LH.seek(0) ?? 0)');
    await shot(`media-${m.id}-00-cover.png`, 'viewport');
    for (const [i, b] of m.beats.entries()) {
      await evalJson(`JSON.stringify(window.__LH.seekBeat(${JSON.stringify(b)}, 0.7) ?? 0)`);
      await new Promise(r => setTimeout(r, 120));
      await shot(`media-${m.id}-${String(i + 1).padStart(2, '0')}-${b}.png`, 'viewport');
    }
    const after = await evalJson('JSON.stringify(window.__LH.errors)');
    after.forEach(e => err(`media/${m.id}`, `seek 时出错：${e}`));
    takeConsoleErrors().forEach(e => err(`media/${m.id} console`, e));
  }

  // ---- 3) 每个交互组件单独打开 ----
  await viewport(1000, 800);
  for (const v of report.viz) {
    takeConsoleErrors();
    await goto(`${ORIGIN}${lessonPath}viz/${v.id}.html`);
    await new Promise(r => setTimeout(r, 800));
    await shot(`viz-${v.id}.png`);
    takeConsoleErrors().forEach(e => err(`viz/${v.id} console`, e));
  }
} catch (e) {
  err('qa', e.message);
} finally {
  chrome?.close();
  server?.kill();
  await sleep(300);
  await rm(path.join(ROOT, '.tmp', `qa-chrome-${process.pid}`), { recursive: true, force: true }).catch(() => {});
  await rm(LOCK, { force: true });
}

report.errors = [...new Set(report.errors)];
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const mediaMin = report.media.reduce((a, m) => a + (m.duration || 0), 0) / 60;
console.log(`QA ${lessonPath}${only ? `${only.kind}/${only.id}` : ''}`);
console.log(`  预计 ${report.est} 分钟（其中配音动画共 ${mediaMin.toFixed(1)} 分钟），${report.sections?.length ?? 0} 段，${report.quizzes ?? 0} 道小测${report.guesses ? `（另有 ${report.guesses} 道先猜）` : ''}，${report.media.length} 个配音动画，${report.viz.length} 个交互组件`);
console.log(`  错误 ${report.errors.length}，警告 ${report.warnings.length}，截图 ${report.screenshots.length} 张 → ${fwd(path.relative(ROOT, OUT))}/`);
for (const e of report.errors) console.log(`  ✗ ${e}`);
for (const w of report.warnings) console.log(`  ⚠ ${w}`);
process.exit(report.errors.length ? 1 : 0);
