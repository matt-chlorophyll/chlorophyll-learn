#!/usr/bin/env node
// serve.mjs — 本地学习服务器
// - 只对外提供 site/ 目录（curriculum/、learner/ 等永远无法通过网页访问，防剧透）
// - 不列目录；支持 Range 请求（音频拖动需要）
// - POST /api/event：把学习行为追加到 learner/events.jsonl
// - GET  /api/health：健康检查
// 用法：node tools/serve.mjs    （端口取 .env 里的 PORT，默认 4321，只监听本机）

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const EVENTS = path.join(ROOT, 'learner', 'events.jsonl');
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';

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

// 带时区的本地时间，便于分析"什么时候学习"
function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
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
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
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
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, app: 'chlorophyll-learn' });
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
