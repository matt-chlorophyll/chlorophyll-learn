// server.mjs — 本地服务器的健康检查和后台启动。serve.mjs（--detach、--stop）、qa.mjs 和 render-video.mjs 共用。
// 后台启动的服务器是独立进程：不随启动它的命令结束，也不受 Claude Code 后台任务的时长限制，一直运行到 `node tools/serve.mjs --stop`。

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// /api/health 的内容 { ok, app, pid, root }；没开或者不是 Chlorophyll-Learn 返回 null（更新前启动的服务器没有 pid 和 root）
export async function health(port) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).json();
    return j?.app === 'chlorophyll-learn' ? j : null;
  } catch { return null; }
}

export const samePath = (a, b) => {
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

// 端口上是别的工作区的服务器：用它会看到、截到别的工作区的课
function checkRoot(h, root, port) {
  if (h.root && !samePath(h.root, root)) throw new Error(`端口 ${port} 上运行的是另一个工作区的 Chlorophyll-Learn（${h.root}）。在这个工作区的 .env 里换一个 PORT。`);
  return h;
}

// 确保 root 这个工作区的服务器在 port 上运行：没开就起一个独立的后台进程，日志写 .tmp/server.log，等能响应再返回。
// 返回 { started, pid }；起不来就抛错，错误里带日志的最后几行
export async function ensureServer(root, port) {
  const running = await health(port);
  if (running) return { started: false, pid: checkRoot(running, root, port).pid };

  mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const log = path.join(root, '.tmp', 'server.log');
  const fd = openSync(log, 'w');
  const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs')], {
    cwd: root, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, PORT: String(port) },
  });
  closeSync(fd);
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.unref();

  // 最多等约 10 秒；进程提前退出就不用等了（同时有别的命令也在启动时，它会发现已经在运行并退出，下面的检查照样能通过）
  for (let i = 0; i < 50 && !exited; i++) {
    const h = await health(port);
    if (h) return { started: true, pid: checkRoot(h, root, port).pid };
    await sleep(200);
  }
  const h = await health(port);
  if (h) return { started: !exited, pid: checkRoot(h, root, port).pid };
  const tail = existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).slice(-15).join('\n') : '';
  throw new Error(`本地服务器没有启动起来（端口 ${port}）${tail ? `。日志 .tmp/server.log 的最后几行：\n${tail}` : ''}`);
}
