// ask.mjs — 网页「问老师」：POST /api/ask，调用 claude -p 回答课程页上的提问（serve.mjs 第一次收到提问时才加载）
//
// - claude -p 是 --print 的缩写，即 Claude Code 的非交互模式：从 stdin 读一个问题，把回答打印到 stdout，然后退出。每次提问都新开一个这样的进程
// - 老师的规则在 platform/ask-teacher.md，作为 system prompt；学习者档案、已学概念、本周概念、正在读的段落随问题一起发
// - 关掉所有工具和 MCP：老师读不到任何文件（包括 curriculum/），只能看到这里发给它的内容
// - 无状态：这节课之前的问答由页面每次带上（模型不记得上一次调用）
// - 回答按行流式返回（NDJSON，也叫 JSON Lines：每行一条完整的 JSON）：{"t":"d","x":"一段文字"} …，最后是 {"t":"end","cat":"now"|"dig"|"weekend","tag":"标签"|null,"hint":true|false} 或 {"t":"err","msg":"…"}
// - 归类 cat：当场讲完（now）、想深挖（dig，老师写了 ⟦停车场：标签⟧）、周末问（weekend，老师写了 ⟦周末问⟧）
// - 每次问答记一条 ask 事件进 learner/events.jsonl（QA 模式不记），包括归类、是不是「稍后看」（later）、做题时老师是否只给了提示（⟦提示⟧）、学习者是否要了答案（⟦看答案⟧）
// - 页面断开（刷新、关掉、离开）不影响回答：照常答完、记进学习记录。只有页面发来 {"stop":"<提问 id>"}（点了「停止」）才停
// - 点「发送，稍后看」的提问，请求体里 later 是 true；当场回答中途点「稍后看」的，页面另发一个 {"later":"<提问 id>"}，这条也记成稍后看
// - 同时最多 MAX_RUNNING 个 claude 进程，多出来的提问排队（「稍后看」可以连着存好几条）
// 可在 .env 里改：ASK_MODEL（默认 sonnet）、ASK_EFFORT（默认 low）、CLAUDE_BIN（claude 不在 PATH 里时）

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 120_000;
const MAX_RUNNING = 2, MAX_WAITING = 8;
const PARK = /⟦停车场[:：]\s*([^⟧]{1,40})⟧/, WEEKEND = /⟦周末问[^⟧]*⟧/, HINT = /⟦提示[^⟧]*⟧/, REVEAL = /⟦看答案[^⟧]*⟧/, MARKS = /⟦[^⟧]*⟧/g;
let running = 0;
const waiting = []; // 排队的提问：每项是轮到它时调用的函数
const live = new Map(); // 提问 id → { stop, later }：页面点「停止」时停下这个提问；回答中途点「稍后看」时把它记成稍后看

// 拿到一个位置才开始回答；答完把位置直接交给排在最前面的提问
function acquire() {
  if (running < MAX_RUNNING) { running++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

// 启动 claude。Windows 上用 npm 装的 Claude Code 是 claude.cmd 包装：Node 不能直接启动 .cmd（spawn 会直接抛 EINVAL），
// 按名字也找不到它（只找 .exe），要经过 cmd.exe。经过 cmd.exe 时 kill() 只结束 cmd 自己，
// 所以换成 taskkill 连同 claude 一起结束，「停止」和超时才真的停得下来
let claudeBin = null; // Windows 上找到的 claude.exe / claude.cmd 路径，找到一次就记住
function startClaude(args, opts) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  if (process.platform !== 'win32') return spawn(bin, args, opts);
  claudeBin ??= /\.(exe|cmd|bat)$/i.test(bin) ? bin
    : (spawnSync('where', [bin], { encoding: 'utf8', windowsHide: true }).stdout || '').split(/\r?\n/).map(s => s.trim()).find(p => /\.(exe|cmd|bat)$/i.test(p)) ?? null;
  if (!claudeBin || /\.exe$/i.test(claudeBin)) return spawn(claudeBin || bin, args, opts);
  const child = spawn([claudeBin, ...args].map(a => `"${a}"`).join(' '), { ...opts, shell: true });
  child.kill = () => spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  return child;
}

const clip = (s, n) => {
  s = String(s ?? '').trim();
  return s.length > n ? `${s.slice(0, n)}……` : s;
};
const readText = p => readFile(p, 'utf8').catch(() => '');

// markdown 里取一个「## 标题」下的内容
function mdSection(md, title) {
  const part = md.split(/^## /m).find(p => p.startsWith(title));
  return part ? part.slice(title.length).trim() : '';
}

// 只接受本机课程页发来的 JSON：别的网站不能借浏览器调用这个接口（它会消耗 Claude 额度）
function fromLessonPage(req, port) {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  return hosts.includes(req.headers.host)
    && hosts.some(h => req.headers.origin === `http://${h}`)
    && /^application\/json\b/.test(req.headers['content-type'] || '');
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function buildPrompt(b, ctx) {
  const out = [
    '# 学习者档案', ctx.profile || '（没有）', '',
    '# 已学概念', ctx.concepts || '（没有）', '',
    '# 本周概念', ctx.week || '（没有）', '',
    '# 正在读', `${clip(b.lesson, 80) || '（未知课程）'}（${clip(b.page, 120)}）`,
  ];
  if (b.section) out.push(`第 ${Number(b.section.n) || '?'} 段「${clip(b.section.title, 80)}」`, '', '## 这一段的内容', clip(b.section.text, 4000));
  const history = Array.isArray(b.history) ? b.history.slice(-6) : [];
  if (history.length) {
    out.push('', '# 这节课之前的问答（从早到晚）');
    for (const t of history) out.push(`学习者：${clip(t.q, 600)}`, `老师：${clip(t.a, 1500)}`, '');
  }
  if (b.quote) out.push('', '# 学习者选中的文字', clip(b.quote, 1200));
  out.push('', '# 学习者的问题', clip(b.question, 1500));
  return out.join('\n');
}

// claude 的报错翻译成学习者能照着做的提示
function explain(raw) {
  const s = String(raw || '');
  if (/not logged in|\/login|authenticat|invalid api key/i.test(s)) return 'Claude Code 还没登录：在终端里运行 claude，按提示登录一次，再回来问。';
  if (/rate.?limit|usage limit|overloaded|429|529/i.test(s)) return 'Claude 现在太忙或用量到上限了。过几分钟再问，或者先在 Claude Code 里问。';
  return `老师没答上来：${clip(s.replace(/\s+/g, ' '), 200) || '原因不明'}。再问一次试试，还不行就在 Claude Code 里问。`;
}

export async function handleAsk(req, res, { root, port, record }) {
  if (!fromLessonPage(req, port)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '只接受本机课程页的提问' }));
  }
  const b = await readBody(req);
  // 页面发来的小请求，不是提问：{"stop":id} 停掉那个提问（还在排队的就不再回答）；{"later":id} 把那个提问记成稍后看
  // （提问本身的 later 是 true/false，不是字符串）
  const op = typeof b?.stop === 'string' ? 'stop' : typeof b?.later === 'string' ? 'later' : null;
  if (op) {
    live.get(b[op])?.[op]();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (!b || typeof b.question !== 'string' || !b.question.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '问题是空的' }));
  }
  if (waiting.length >= MAX_WAITING) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '老师手上的问题太多了，等它答完几条再问。' }));
  }
  // 先登记好：「停止」「稍后看」可能在下面读文件、排队的时候就到了
  const id = typeof b.id === 'string' ? b.id.slice(0, 64) : null;
  let text = '', result = null, stderr = '', failure = null, child = null, later = b.later === true;
  if (id) live.set(id, { stop: () => { failure ??= '已停止'; child?.kill(); }, later: () => { later = true; } });
  let closed = false; // 页面断开了（刷新、关掉、离开，或者点了「停止」）
  res.on('close', () => { closed = true; });

  const [profile, concepts, state] = await Promise.all(['profile.md', 'concepts.md', 'state.md'].map(f => readText(path.join(root, 'learner', f))));
  const prompt = buildPrompt(b, { profile, concepts, week: mdSection(state, '本周概念') });

  // 在空目录里运行：不让 claude 自动读到项目的 CLAUDE.md；去掉练习用的 ANTHROPIC_API_KEY，用 Claude Code 的登录额度
  const cwd = path.join(os.tmpdir(), 'chlorophyll-learn-ask');
  await mkdir(cwd, { recursive: true });
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  const args = ['-p', '--model', process.env.ASK_MODEL || 'sonnet', '--effort', process.env.ASK_EFFORT || 'low',
    '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--system-prompt-file', path.join(root, 'platform', 'ask-teacher.md'),
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  // 页面断开以后不再往回写，但回答照常进行
  const send = m => { if (!closed && !res.writableEnded) res.write(`${JSON.stringify(m)}\n`); };

  await acquire();
  const started = Date.now();
  // 排队时没被停掉才开始回答；启动就失败（同步抛错）时照样走到下面的 release()，名额不会漏
  try { if (!failure) child = startClaude(args, { cwd, env, windowsHide: true }); } catch (e) { failure = explain(e.message); }
  if (!failure) {
    const timer = setTimeout(() => { failure = '老师想太久了（超过 2 分钟）。换个更具体的问法再试一次。'; child.kill(); }, TIMEOUT_MS);

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const d = j.type === 'stream_event' && j.event?.type === 'content_block_delta' ? j.event.delta : null;
        if (d?.type === 'text_delta') { text += d.text; send({ t: 'd', x: d.text }); }
        else if (j.type === 'result') result = j;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', s => { stderr = (stderr + s).slice(-4000); });
    child.stdin.on('error', () => { /* 进程没起来时写 stdin 会报错，由 error/close 处理 */ });
    child.stdin.end(prompt);

    await new Promise(resolve => {
      child.on('error', e => {
        failure ??= e.code === 'ENOENT' ? '找不到 claude 命令：确认 Claude Code 装好了，并且在命令行里输入 claude 能打开。' : explain(e.message);
        resolve();
      });
      child.on('close', resolve);
    });
    clearTimeout(timer);
  }
  release();
  if (id) live.delete(id);

  const ok = !failure && result && !result.is_error;
  if (!ok) failure ??= explain(result?.result || stderr || (result ? result.subtype : '回答中断了'));
  // 归类：两个标记都写了的话算想深挖（没打好基础比要动手练更要紧）
  const parked = ok ? text.match(PARK)?.[1].trim() ?? null : null;
  const cat = !ok ? null : parked ? 'dig' : WEEKEND.test(text) ? 'weekend' : 'now';
  const hint = ok && HINT.test(text), revealed = ok && REVEAL.test(text);
  const unseen = ok && closed; // 页面没收到这条回答：回答好之前刷新、关掉或离开了
  send(ok ? { t: 'end', cat, tag: parked, hint } : { t: 'err', msg: failure });
  if (!closed) res.end();

  if (b.qa) return;
  await record({
    type: 'ask', page: clip(b.page, 200), sec: b.section?.id ?? null, question: clip(b.question, 1500), quote: clip(b.quote, 300),
    later: later || undefined, answer: clip(text.replace(MARKS, ''), 3000), cat: cat ?? undefined, tag: parked ?? undefined,
    hint: hint || undefined, revealed: revealed || undefined, ok, error: ok ? undefined : failure,
    unseen: unseen || undefined,
    ms: Date.now() - started, model: result?.modelUsage ? Object.keys(result.modelUsage)[0] : undefined,
  }).catch(e => console.error('ask 事件没记上：', e.message));
}
