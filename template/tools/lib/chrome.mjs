// chrome.mjs — 启动本机的 Chrome / Edge（headless），用 DevTools 协议（CDP）控制页面。qa.mjs、render-video.mjs 和 qa-hub.mjs 共用。
// 不依赖 npm 包，也不需要另外下载浏览器：找不到时可以用环境变量 CHROME_BIN 指定浏览器路径。
// qa-hub.mjs 另外用到 gpu、窗口大小、像素比、额外参数（hub 的 3D 地图要开 GPU 才画得出来），和一次只开一个浏览器的锁（withLock）。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function findChrome() {
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.CHROME_BIN,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    local && path.join(local, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ].filter(Boolean);
  const hit = candidates.find(p => existsSync(p));
  if (!hit) throw new Error('没找到 Chrome 或 Edge：装一个 Chrome，或者在 .env 里用 CHROME_BIN 指定浏览器路径');
  return hit;
}

// 启动一个独立的 headless 浏览器（用自己的配置目录，不影响你平时用的浏览器）。
// 选项：
//   gpu      true：用真显卡画 WebGL（Windows 上走 ANGLE / D3D11，不理会显卡黑名单）。默认 false：无头浏览器一般是软件渲染
//   width、height  窗口大小（默认 1280 × 800）；dpr 像素比（默认 1）
//   args     额外的 Chrome 参数，例如 ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']（假装断网，只留本机）
export async function launchChrome(profileDir, { gpu = false, width = 1280, height = 800, dpr = 1, args = [] } = {}) {
  await mkdir(profileDir, { recursive: true });
  const flags = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  ];
  if (gpu) flags.push(...(process.platform === 'win32' ? ['--use-angle=d3d11', '--use-gl=angle'] : []), '--enable-gpu', '--ignore-gpu-blocklist');
  if (dpr !== 1) flags.push(`--force-device-scale-factor=${dpr}`);
  flags.push(...args, 'about:blank');
  const proc = spawn(findChrome(), flags, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('浏览器启动超时（机器内存紧时常这样：关掉别的无头浏览器再试）')), 20000);
    proc.stderr.on('data', d => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('error', e => { clearTimeout(timer); reject(new Error(`无法启动浏览器：${e.message}`)); });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`浏览器退出（${code}）：${buf.slice(-300)}`)); });
  });
  const port = new URL(wsUrl).port;
  return {
    proc,
    port,
    // 新开一个标签页，返回连好的 Cdp
    async newPage() {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const page = new Cdp(target.webSocketDebuggerUrl);
      await page.open();
      page.targetId = target.id;
      return page;
    },
    async closePage(page) {
      page.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${page.targetId}`).catch(() => {});
    },
    // 关掉浏览器，等进程真的退出（Windows 上配置目录要等它退出才删得掉）
    async close() {
      if (proc.exitCode !== null) return;
      const gone = new Promise(r => proc.once('exit', r));
      proc.kill();
      await Promise.race([gone, sleep(5000)]);
    },
  };
}

export class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method) { for (const fn of this.listeners.get(m.method) || []) fn(m.params); return; }
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    };
  }
  open() { return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('连不上浏览器的 DevTools')); }); }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  once(method, ms = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), ms);
      const fn = params => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) || []).filter(f => f !== fn));
        resolve(params);
      };
      this.on(method, fn);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { this.ws.close(); }
}

// 一次只开一个浏览器：用一个目录当锁（mkdir 是原子的），拿到才跑 fn，跑完删掉。
// 拿着锁的时候每 30 秒摸一下目录，别的进程看修改时间判断是不是死锁（超过 stale 毫秒没摸过就抢过来）。
// 内存紧的电脑上并行开几个 GPU 浏览器会起不来，所以给同一个目录的就一起排队
export async function withLock(lockDir, fn, { wait = 60 * 60e3, stale = 15 * 60e3, log = console.log } = {}) {
  if (!lockDir) return fn();
  const t0 = Date.now();
  let said = false;
  for (;;) {
    try { mkdirSync(lockDir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > stale) { log(`锁 ${lockDir} 超过 ${Math.round(stale / 60e3)} 分钟没动，当成死锁拿走`); rmSync(lockDir, { recursive: true, force: true }); continue; }
      } catch { /* 刚好被别人删了：再试一次 */ }
      if (!said) { log(`等锁 ${lockDir}（别的截图在跑）`); said = true; }
      if (Date.now() - t0 > wait) throw new Error(`等锁超时：${lockDir}`);
      await sleep(5000);
    }
  }
  const tick = setInterval(() => { try { const n = new Date(); utimesSync(lockDir, n, n); } catch { /* 没关系 */ } }, 30e3);
  try { return await fn(); } finally { clearInterval(tick); try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* 没关系 */ } }
}
