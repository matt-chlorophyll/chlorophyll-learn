#!/usr/bin/env node
// render-video.mjs — 把配音动画导出成 mp4（基于 scene 的确定性 seek(t) 逐帧截图，再用 ffmpeg 编码）
//
// 用法：node tools/render-video.mjs <课程目录或动画目录> [--fps 30] [--scale 1.5] [--no-cc] [--portrait] [--force]
//   例：node tools/render-video.mjs site/lessons/<topic>/w00/d0            （这节课的所有动画）
//       node tools/render-video.mjs site/lessons/<topic>/w00/d0/media/one-request
// 输出：每个动画目录下的 video.mp4（1280×720 × scale，默认 1920×1080；字幕默认烧进画面，--no-cc 不要字幕）。
// --portrait：竖屏，打开 scene.html?portrait（场景要支持 ctx.portrait），输出 video-portrait.mp4（720×1280 × scale，默认 1080×1920）。
// 已有的 mp4 比 scene.html / audio.mp3 / timeline.json 都新时跳过，--force 强制重做。
//
// 用一个独立的 headless Chrome / Edge（tools/lib/chrome.mjs），通过 DevTools 协议控制。
// 需要本机装了 Chrome 或 Edge，以及 ffmpeg；服务器没开会在后台启动（之后一直运行，停止用 node tools/serve.mjs --stop）。无配音（silent）的动画导出成没有声音、带字幕的 mp4。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib/chrome.mjs';
import { ensureServer } from './lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT) || 4321;
const ORIGIN = `http://localhost:${PORT}`;
const SITE = path.join(ROOT, 'site');

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const target = args.find((a, i) => !a.startsWith('--') && !['--fps', '--scale'].includes(args[i - 1]));
if (!target) { console.log('用法：node tools/render-video.mjs <课程目录或动画目录> [--fps 30] [--scale 1.5] [--no-cc] [--portrait] [--force]'); process.exit(1); }
const FPS = Number(opt('fps', 30));
const SCALE = Number(opt('scale', 1.5));
const PORTRAIT = flag('portrait');
const [W, H] = PORTRAIT ? [720, 1280] : [1280, 720];
const OUT = PORTRAIT ? 'video-portrait.mp4' : 'video.mp4';

// ---------- 找要导出的动画 ----------

function resolveDir(t) {
  const cleaned = t.replace(/^[A-Za-z]:\/.*?\/Git\//, '').replace(/^\/+/, '');
  for (const p of [path.resolve(t), path.join(ROOT, cleaned), path.join(SITE, cleaned)]) if (existsSync(p)) return p;
  throw new Error(`找不到目录：${t}`);
}

const dir = resolveDir(target);
const mediaDirs = existsSync(path.join(dir, 'scene.html'))
  ? [dir]
  : existsSync(path.join(dir, 'media'))
    ? readdirSync(path.join(dir, 'media')).map(d => path.join(dir, 'media', d)).filter(d => existsSync(path.join(d, 'scene.html')))
    : [];
if (!mediaDirs.length) { console.error(`${path.relative(ROOT, dir)} 下没有配音动画（media/<id>/scene.html）`); process.exit(1); }
// 没装 ffmpeg：说明一下就退出（/build-week 直接运行这条命令，不用先自己检查）
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true }).error) { console.log('没装 ffmpeg，跳过导出 mp4。装好 ffmpeg 后再运行这条命令就行。'); process.exit(0); }

// ---------- 导出一个动画 ----------

const HIDE_CHROME = `
  .lh-controls, .lh-big { display: none !important; }
  .lh-player, .lh-player * { cursor: none !important; }
  .lh-player:focus, .lh-player:focus-visible { outline: none !important; }
`;
const HIDE_CC = '.lh-cc { display: none !important; }';

function upToDate(d) {
  const out = path.join(d, OUT);
  if (!existsSync(out)) return false;
  const t = statSync(out).mtimeMs;
  return ['scene.html', 'audio.mp3', 'timeline.json'].every(f => !existsSync(path.join(d, f)) || statSync(path.join(d, f)).mtimeMs < t);
}

async function render(chrome, d) {
  const rel = path.relative(SITE, d).replaceAll('\\', '/');
  const out = path.join(d, OUT);
  const page = await chrome.newPage();
  let ffErr = '';
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: `${ORIGIN}/${rel}/scene.html${PORTRAIT ? '?portrait' : ''}` });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { await sleep(200); ready = await page.eval('window.__LH?.ready === true').catch(() => false); }
    if (!ready) throw new Error('场景 20 秒内没有就绪（window.__LH.ready）');
    await page.eval('document.fonts.ready.then(() => true)');
    await page.eval(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(HIDE_CHROME + (flag('no-cc') ? HIDE_CC : ''))}; document.head.append(s); document.activeElement?.blur(); return true; })()`);
    const duration = await page.eval('window.__LH.duration');
    const errors = await page.eval('window.__LH.errors?.length ? window.__LH.errors : []');
    if (errors.length) throw new Error(`场景报错：${errors.join('；')}`);

    const frames = Math.ceil(duration * FPS);
    const audio = path.join(d, 'audio.mp3');
    const withAudio = existsSync(audio) && !(await page.eval('window.__LH.silent === true'));
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
      ...(withAudio ? ['-i', audio, '-map', '0:v', '-map', '1:a'] : []),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      ...(withAudio ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : ['-an']), '-movflags', '+faststart', out,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    ff.stdin.on('error', () => {}); // ffmpeg 没起来或提前退出时，错误由 close 事件报告
    ff.on('error', e => { ffErr += `无法启动 ffmpeg（装好 ffmpeg 再导出）：${e.message}`; });
    ff.stderr.on('data', d => { ffErr += d; });
    const done = new Promise((resolve, reject) => ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg 失败：${ffErr.trim()}`)))));

    const started = Date.now();
    for (let i = 0; i < frames; i++) {
      await page.eval(`window.__LH.seek(${(i / FPS).toFixed(4)})`);
      const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
      if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
      if (i % (FPS * 10) === 0 || i === frames - 1) {
        const pct = (((i + 1) / frames) * 100).toFixed(0);
        process.stdout.write(`\r  ${rel}：${pct}%（${i + 1}/${frames} 帧，${((Date.now() - started) / 1000).toFixed(0)}s）`);
      }
    }
    ff.stdin.end();
    await done;
    const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
    console.log(`\n✓ ${path.relative(ROOT, out).replaceAll('\\', '/')}（${duration.toFixed(1)}s，${Math.round(W * SCALE)}×${Math.round(H * SCALE)}，${FPS}fps，${mb} MB，用时 ${((Date.now() - started) / 1000).toFixed(0)}s）`);
  } finally {
    await chrome.closePage(page);
  }
}

// ---------- main ----------

let chrome;
try {
  const todo = mediaDirs.filter(d => flag('force') || !upToDate(d));
  for (const d of mediaDirs.filter(d => !todo.includes(d))) console.log(`- ${path.relative(ROOT, d).replaceAll('\\', '/')}：${OUT} 已是最新，跳过（--force 重做）`);
  if (todo.length) {
    await ensureServer(ROOT, PORT);
    chrome = await launchChrome(path.join(ROOT, '.tmp', 'render-chrome'));
    for (const d of todo) await render(chrome, d);
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  chrome?.close();
}
