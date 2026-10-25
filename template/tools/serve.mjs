#!/usr/bin/env node
// serve.mjs — 本地学习服务器
// - 只对外提供 site/ 目录（curriculum/、learner/ 等永远无法通过网页访问，防剧透）
// - 不列目录；支持 Range 请求（音频拖动需要）
// - 静态文件带 Last-Modified；浏览器带 If-Modified-Since 来问、文件没改过时回 304（只对不带 Range 的 GET）。
//   Cache-Control 还是 no-cache：每次都来问，但没改过就不用重下（hub 的 3D 地图约 3.5 MB），Chrome 也才会给脚本做代码缓存
// - POST /api/event：把学习行为追加到 learner/events.jsonl
// - GET  /api/health：健康检查（带 pid 和工作区路径，--stop 和 lib/server.mjs 用）
// 用法（端口取 .env 里的 PORT，默认 4321，只监听本机）：
//   node tools/serve.mjs            前台运行（start.cmd、start.sh 用）
//   node tools/serve.mjs --detach   没在运行就在后台启动，等能访问再返回。独立进程，不随 Claude Code 的后台任务结束
//   node tools/serve.mjs --stop     停掉这个工作区的服务器

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { learnerTimezone, nowIn } from './now.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const EVENTS = path.join(ROOT, 'learner', 'events.jsonl');
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';

// --detach、--stop：只管理服务器，这个进程自己不监听
if (process.argv.includes('--detach') || process.argv.includes('--stop')) {
  const { ensureServer, health, samePath } = await import('./lib/server.mjs');
  if (process.argv.includes('--detach')) {
    try {
      const { started } = await ensureServer(ROOT, PORT);
      console.log(`Chlorophyll-Learn ${started ? '已在后台启动' : '已经在运行'}：http://localhost:${PORT}/（日志 .tmp/server.log；停止：node tools/serve.mjs --stop）`);
      process.exit(0);
    } catch (e) { console.error(e.message); process.exit(1); }
  }
  const h = await health(PORT);
  if (!h) { console.log(`端口 ${PORT} 上没有运行 Chlorophyll-Learn`); process.exit(0); }
  if (!h.pid) { console.error('正在运行的服务器是更新前启动的，没法用 --stop 停：关掉 start.cmd 打开的服务器窗口，或者用 start.sh 启动时打印的 kill 命令'); process.exit(1); }
  if (h.root && !samePath(h.root, ROOT)) { console.error(`端口 ${PORT} 上运行的是另一个工作区的服务器（${h.root}），没有停`); process.exit(1); }
  process.kill(h.pid);
  for (let i = 0; i < 25 && (await health(PORT)); i++) await new Promise(r => setTimeout(r, 200));
  if (await health(PORT)) { console.error(`没能停掉服务器（pid ${h.pid}）`); process.exit(1); }
  console.log(`已停止 Chlorophyll-Learn（端口 ${PORT}）`);
  process.exit(0);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
};

// 带时区的时间，按学习者的时区（learner/profile.md，没写就用电脑的时区），便于分析"什么时候学习"
function localIso(d = new Date()) {
  const n = nowIn(learnerTimezone(ROOT).timezone, d);
  return `${n.date}T${n.time}${n.offset}`;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

async function handleEvent(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) return sendJson(res, 413, { error: 'too large' });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendJson(res, 400, { error: 'bad json' }); }
  const events = (Array.isArray(body) ? body : [body]).filter(e => e && typeof e === 'object' && typeof e.type === 'string');
  if (events.length) {
    await mkdir(path.dirname(EVENTS), { recursive: true });
    const ts = localIso();
    await appendFile(EVENTS, events.map(e => JSON.stringify({ ts, ...e })).join('\n') + '\n');
  }
  sendJson(res, 200, { ok: true, n: events.length });
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return notFound(res); }
  const abs = path.resolve(SITE, '.' + rel);
  if (abs !== SITE && !abs.startsWith(SITE + path.sep)) return notFound(res);
  if (!existsSync(abs)) return notFound(res);

  let file = abs;
  let st = statSync(abs);
  if (st.isDirectory()) {
    // 目录必须以 / 结尾，否则页面里的相对路径会解析错
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: pathname + '/' });
      return res.end();
    }
    file = path.join(abs, 'index.html');
    if (!existsSync(file)) return notFound(res); // 不列目录
    st = statSync(file);
  }

  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() };
  // 304：HTTP 的日期只到秒，所以文件的修改时间也按秒比。日期写错、比现在还晚的，照常回 200
  if (req.method === 'GET' && !req.headers.range && req.headers['if-modified-since']) {
    const since = Date.parse(req.headers['if-modified-since']);
    if (!Number.isNaN(since) && since <= Date.now() && Math.floor(st.mtimeMs / 1000) * 1000 <= since) {
      res.writeHead(304, { 'Cache-Control': 'no-cache', 'Last-Modified': headers['Last-Modified'] });
      return res.end();
    }
  }
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start, end;
    if (range[1] === '') { start = Math.max(0, st.size - Number(range[2])); end = st.size - 1; }
    else { start = Number(range[1]); end = range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1); }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

// 只回答 site/ 里的某个文件是否存在：播放器用它判断有没有导出的 mp4，免得 404 被浏览器记成控制台错误
function siteFileExists(p) {
  if (!p) return false;
  const abs = path.resolve(SITE, '.' + p);
  if (abs !== SITE && !abs.startsWith(SITE + path.sep)) return false;
  return existsSync(abs) && statSync(abs).isFile();
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, `http://${HOST}`);
    if (pathname === '/api/event' && req.method === 'POST') return await handleEvent(req, res);
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, app: 'chlorophyll-learn', pid: process.pid, root: ROOT });
    if (pathname === '/api/exists') return sendJson(res, 200, { exists: siteFileExists(searchParams.get('path')) });
    // POST /api/ask：网页「问老师」，调用 claude -p 回答（tools/ask.mjs，第一次提问时才加载）
    if (pathname === '/api/ask' && req.method === 'POST') {
      const { handleAsk } = await import('./ask.mjs');
      return await handleAsk(req, res, { root: ROOT, port: PORT, record: e => appendFile(EVENTS, `${JSON.stringify({ ts: localIso(), ...e })}\n`) });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    res.writeHead(405);
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') throw e;
  // 端口被占用：如果占用者就是 Chlorophyll-Learn，说明已经在运行了
  const ok = await fetch(`http://${HOST}:${PORT}/api/health`).then(r => r.json()).then(j => j.app === 'chlorophyll-learn').catch(() => false);
  if (ok) { console.log(`Chlorophyll-Learn 已经在运行：http://localhost:${PORT}/`); process.exit(0); }
  console.error(`端口 ${PORT} 被其他程序占用，请在 .env 里换一个 PORT`);
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`Chlorophyll-Learn 已启动：http://localhost:${PORT}/`));
