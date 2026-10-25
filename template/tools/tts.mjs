#!/usr/bin/env node
// tts.mjs — 把配音稿 script.json 合成为 audio.mp3 + timeline.json（beat 时间轴 + 字幕）
//
// 用法：
//   node tools/tts.mjs <脚本目录> [--out <输出目录>] [--provider minimax|elevenlabs|silent]
//                       [--voice <voice_id>] [--speed <倍率>] [--model <模型>]
//   node tools/tts.mjs voices <minimax|elevenlabs> [关键词]
//   node tools/tts.mjs design "<声音描述>" --text "<试听文本>" --out <试听.mp3>   （MiniMax 声音设计，只生成试听）
//
// script.json：
//   { "beats": [ { "id": "intro", "text": "字幕与配音文本", "say": "可选：只送给 TTS 的读法", "pauseAfter": 0.4 } ],
//     "provider": "可选", "voice": "可选", "speed": 可选 }
//
// - 每个 beat 单独合成，按内容哈希缓存在 .cache/tts/；改稿后重跑只会重新合成改动过的 beat。
// - 时长由解码后的采样数精确计算，所以 timeline.json 与 audio.mp3 严格对齐。
// - provider=silent 不调用任何 API，按字数估算时长，只写 timeline.json（不生成音频；播放器显示字幕，默认用浏览器朗读）。
//   没有指定 --provider、而默认 provider 的 key 没填或没装 ffmpeg 时，自动改用 silent。
// - 默认配置在 platform/tts.json，发音词表在 platform/pronunciation.md。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'tts');
const SR = 44100; // 拼接时统一用 44.1kHz 单声道 s16le
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const USAGE = `用法：
  node tools/tts.mjs <脚本目录> [--out <输出目录>] [--provider minimax|elevenlabs|silent] [--voice <id>] [--speed <倍率>] [--model <模型>]
  node tools/tts.mjs voices <minimax|elevenlabs> [关键词]
  node tools/tts.mjs design "<声音描述>" --text "<试听文本>" --out <试听.mp3>`;

// ---------- 通用 ----------

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
    else { flags[a.slice(2)] = next; i++; }
  }
  return { pos, flags };
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少 ${name}：请把 .env.example 复制为 .env 并填写`);
  return v;
}

const r3 = x => Math.round(x * 1000) / 1000;
const silence = sec => Buffer.alloc(Math.round(sec * SR) * 2);

let ffmpegOk;
const hasFfmpeg = () => (ffmpegOk ??= new Promise(resolve => {
  const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
  p.on('error', () => resolve(false));
  p.on('close', code => resolve(code === 0));
}));

function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const out = [];
    let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d; });
    p.stdin.on('error', () => {}); // ffmpeg 提前退出时忽略 EPIPE，错误由 close 事件报告
    p.on('error', e => reject(new Error(`无法启动 ffmpeg：${e.message}`)));
    p.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg 失败：${err.trim()}`))));
    p.stdin.end(input);
  });
}

// 去掉每段 TTS 输出首尾多余的静音（各保留一点点），让 beat 之间的停顿只由 pauseAfter 决定
const TRIM = [
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05',
  'areverse',
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08',
  'areverse',
].join(',');
const decodePcm = file => ffmpeg(['-i', file, '-af', TRIM, '-f', 's16le', '-ac', '1', '-ar', String(SR), 'pipe:1']);

// 响度统一：不同声音（甚至同一声音的不同 beat）原始响度能差 10 dB 以上，同一个动画里会忽大忽小。
// 每个 beat 测"有声部分"的 RMS（20ms 一帧，去掉比最响部分低 30 dB 以上的帧），整体增益调到目标值；
// 超过 -1 dBFS 的瞬时峰值由前瞻限幅器压下去（不削波）。不能只把增益封顶在峰值以内：
// 男声 Sincere Adult 峰值/有效值比很高，封顶后会比女声小约 4 dB。
function normalize(pcm, targetDb) {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const level = voicedLevel(s);
  if (level == null) return { pcm, gain: 0 };
  let gainDb = Math.min(targetDb - level, 24);
  let r = applyGain(s, gainDb);
  // 限幅会压低有效值（峰值多的声音更明显）：复测一次，差得多就再补一点增益（最多 +3 dB）
  const short = targetDb - voicedLevel(r.out);
  if (short > 0.5) { gainDb += Math.min(short, 3); r = applyGain(s, gainDb); }
  return { pcm: Buffer.from(r.out.buffer), gain: gainDb, level, limited: r.limited };
}

// "有声部分"的 RMS（dBFS）：20ms 一帧，只算比最响帧低 30 dB 以内的帧
function voicedLevel(s) {
  const F = Math.round(SR * 0.02);
  const frames = [];
  for (let i = 0; i + F <= s.length; i += F) {
    let sum = 0;
    for (let j = i; j < i + F; j++) sum += s[j] * s[j];
    frames.push(sum / F);
  }
  const loud = Math.max(...frames, 1);
  const voiced = frames.filter(p => p > loud / 1000);
  if (!voiced.length) return null;
  return 10 * Math.log10(voiced.reduce((a, b) => a + b, 0) / voiced.length / 32768 ** 2);
}

function applyGain(s, gainDb) {
  const g = 10 ** (gainDb / 20);
  const env = limiterGain(s, g, 32768 * 0.89);
  const out = new Int16Array(s.length);
  let minEnv = 1;
  for (let i = 0; i < s.length; i++) {
    minEnv = Math.min(minEnv, env[i]);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s[i] * g * env[i])));
  }
  return { out, limited: -20 * Math.log10(minEnv) };
}

// 前瞻限幅器：返回每个采样的附加增益（≤1），保证 |s·g·env| ≤ ceil。
// 1) r = 每个采样需要的增益；2) m[k] = r 在 [k, k+2L] 上的最小值（单调队列）；
// 3) 对 m 做长度 L 的滑动平均（落在 [i-L, i] 的每个窗口都覆盖 i，所以平均值仍 ≤ r[i]），压下去的过程是平滑的；
// 4) 释放时按约 60ms 的时间常数慢慢回到 1。
function limiterGain(s, g, ceil) {
  const n = s.length, L = Math.round(SR * 0.003), W = 2 * L;
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.abs(s[i] * g); r[i] = a > ceil ? ceil / a : 1; }
  const m = new Float32Array(n);
  const q = new Int32Array(n);
  let head = 0, tail = 0, next = 0;
  for (let k = 0; k < n; k++) {
    const hi = Math.min(n - 1, k + W);
    for (; next <= hi; next++) { while (tail > head && r[q[tail - 1]] >= r[next]) tail--; q[tail++] = next; }
    while (q[head] < k) head++;
    m[k] = r[q[head]];
  }
  const env = new Float32Array(n);
  const rel = 1 - Math.exp(-1 / (SR * 0.06));
  let sum = 0, prev = 1;
  for (let i = 0; i < n; i++) {
    sum += m[i];
    if (i > L) sum -= m[i - L - 1];
    const a = sum / Math.min(i + 1, L + 1);
    prev = a < prev ? a : prev + (a - prev) * rel;
    env[i] = Math.min(prev, r[i]);
  }
  return env;
}

async function pool(tasks, n) {
  let next = 0;
  const worker = async () => { while (next < tasks.length) await tasks[next++](); };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}

function retryable(msg, canRetry) {
  const e = new Error(msg);
  e.retryable = canRetry;
  return e;
}

async function withRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= 3 || !e.retryable) throw e;
      const wait = 1500 * 2 ** attempt;
      console.warn(`  ${label} 失败（${e.message}），${wait / 1000}s 后重试`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ---------- 发音词表 ----------

async function loadGlossary() {
  const file = path.join(ROOT, 'platform', 'pronunciation.md');
  if (!existsSync(file)) return [];
  const rows = (await readFile(file, 'utf8')).split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('|'));
  return rows.slice(1) // 跳过表头
    .filter(l => !/^\|\s*:?-{3,}/.test(l))
    .map(l => l.split('|').slice(1, -1).map(s => s.trim()))
    .filter(([from, to]) => from && to && from !== to)
    .map(([from, to]) => ({
      re: new RegExp(`(?<![A-Za-z0-9])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'g'),
      to,
    }));
}
const applyGlossary = (text, glossary) => glossary.reduce((s, g) => s.replace(g.re, g.to), text);

// ---------- 字幕切分 ----------

// 朗读时长的粗略权重：汉字 1，英文单词 1.6，数字 0.7
function weight(s) {
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const words = (s.match(/[A-Za-z]+/g) || []).length;
  const digits = (s.match(/\d/g) || []).length;
  return Math.max(0.5, cjk + words * 1.6 + digits * 0.7);
}

// 先按句末标点切；过长的句子再按逗号类标点切。英文句点不切（避免拆开 Three.js、2.5 这类写法）。
function splitCaption(text, max = 22) {
  const out = [];
  for (const sentence of text.match(/[^。！？!?；;]+[。！？!?；;]*/g) || [text]) {
    if (weight(sentence) <= max) { out.push(sentence); continue; }
    let buf = '';
    for (const piece of sentence.match(/[^，,、：:]+[，,、：:]*/g) || [sentence]) {
      if (buf && weight(buf + piece) > max) { out.push(buf); buf = piece; } else buf += piece;
    }
    if (buf) out.push(buf);
  }
  return out.map(s => s.trim().replace(/[，,、。；;：:]+$/, '')).filter(Boolean);
}

// beat 内的字幕按字数权重分配时长
function makeCues(text, start, end) {
  const parts = splitCaption(text);
  const ws = parts.map(weight);
  const total = ws.reduce((a, b) => a + b, 0);
  let t = start;
  return parts.map((p, i) => {
    const d = ((end - start) * ws[i]) / total;
    const cue = { start: r3(t), end: r3(t + d), text: p };
    t += d;
    return cue;
  });
}

// ---------- TTS providers ----------

const providers = {
  async minimax(text, c) {
    const host = process.env.MINIMAX_API_HOST || 'https://api.minimax.io';
    const res = await fetch(`${host}/v1/t2a_v2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${need('MINIMAX_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.model,
        text,
        stream: false,
        output_format: 'hex',
        voice_setting: { voice_id: c.voice, speed: c.speed, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: SR, bitrate: 128000, format: 'mp3', channel: 1 },
        ...(c.language_boost ? { language_boost: c.language_boost } : {}),
      }),
    }).catch(e => { throw retryable(`网络错误：${e.message}`, true); });
    const j = await res.json().catch(() => ({}));
    const code = j.base_resp?.status_code;
    if (!res.ok || code !== 0 || !j.data?.audio) {
      throw retryable(`MiniMax HTTP ${res.status} code=${code} ${j.base_resp?.status_msg ?? ''}`,
        res.status >= 500 || [1000, 1001, 1002, 1039].includes(code));
    }
    return Buffer.from(j.data.audio, 'hex');
  },

  async elevenlabs(text, c) {
    if (!c.voice) throw new Error('ElevenLabs 需要 voice：在 platform/tts.json 里设置，或用 --voice 指定（node tools/tts.mjs voices elevenlabs 可以列出可用声音）');
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(c.voice)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': need('ELEVENLABS_API_KEY'), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: c.model,
          voice_settings: { stability: c.stability ?? 0.5, similarity_boost: c.similarity_boost ?? 0.75, speed: c.speed },
        }),
      },
    ).catch(e => { throw retryable(`网络错误：${e.message}`, true); });
    if (!res.ok) {
      throw retryable(`ElevenLabs HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, res.status === 429 || res.status >= 500);
    }
    return Buffer.from(await res.arrayBuffer());
  },
};

// silent：按字数估算时长（约 4.2 字/秒）
function estimateSeconds(text, speed) {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.match(/[A-Za-z]+/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  return (cjk / 4.2 + words / 2.6 + digits / 3) / speed + 0.2;
}

// ---------- 合成 ----------

async function synthesize(dir, flags) {
  const scriptFile = path.join(dir, 'script.json');
  if (!existsSync(scriptFile)) throw new Error(`找不到 ${scriptFile}`);
  const script = JSON.parse(await readFile(scriptFile, 'utf8'));
  const base = JSON.parse(await readFile(path.join(ROOT, 'platform', 'tts.json'), 'utf8'));

  const beats = script.beats;
  if (!Array.isArray(beats) || beats.length === 0) throw new Error('script.json 里没有 beats');
  const seen = new Set();
  for (const b of beats) {
    if (!/^[A-Za-z0-9][\w-]*$/.test(b.id ?? '')) throw new Error(`beat id 不合法：${JSON.stringify(b.id)}（只能用字母、数字、- 和 _）`);
    if (seen.has(b.id)) throw new Error(`beat id 重复：${b.id}`);
    if (!b.text?.trim()) throw new Error(`beat ${b.id} 没有 text`);
    if (b.speaker != null && !['a', 'b'].includes(b.speaker)) throw new Error(`beat ${b.id} 的 speaker 只能是 "a" 或 "b"`);
    seen.add(b.id);
  }

  let provider = flags.provider || script.provider || base.provider;
  if (provider !== 'silent' && !providers[provider]) throw new Error(`未知 provider：${provider}`);
  // 没配 key 或没装 ffmpeg：自动降级为无配音（字幕版），课程照常能上；命令行明确指定 --provider 时照常报错
  const KEYS = { minimax: 'MINIMAX_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' };
  if (provider !== 'silent' && !flags.provider) {
    const why = !process.env[KEYS[provider]] ? `.env 里没有 ${KEYS[provider]}` : !(await hasFfmpeg()) ? '没装 ffmpeg' : null;
    if (why) {
      console.warn(`⚠ ${why}：这段动画改用无配音模式（字幕版）。配好以后重跑本命令就有配音。`);
      provider = 'silent';
    }
  }
  const c = { ...(base[provider] || {}) };
  // script 里的 voice/model 只对 script 自己指定的 provider 生效
  if (!script.provider || script.provider === provider) {
    if (script.voice) c.voice = script.voice;
    if (script.model) c.model = script.model;
  }
  if (flags.voice) c.voice = flags.voice;
  if (flags.model) c.model = flags.model;
  c.speed = Number(flags.speed ?? script.speed ?? base.speed ?? 1);

  const outDir = path.resolve(flags.out || dir);
  // 声音：script 或 --voice 指定的优先；否则从 voices 列表里按动画路径的哈希稳定地挑一个（同一个动画重跑不会换声音）。
  // beat 标了 "speaker": "b" 的用列表里的另一个声音（双人对话）。
  const roster = c.voices?.length ? c.voices : [c.voice].filter(Boolean);
  let main = c.voice;
  if (!main && roster.length) {
    const h = createHash('sha1').update(path.relative(path.join(ROOT, 'site'), outDir).replaceAll('\\', '/')).digest();
    main = roster[h[0] % roster.length];
  }
  const other = roster.length > 1 ? roster[(roster.indexOf(main) + 1) % roster.length] : main;
  const voiceOf = b => (b.speaker === 'b' ? other : main);
  // 无配音时没有第二个声音，但对话的字幕照样要分开颜色
  const dialog = (provider === 'silent' || other !== main) && beats.some(b => b.speaker === 'b');
  const glossary = await loadGlossary();
  await mkdir(CACHE, { recursive: true });

  // 1) 逐 beat 合成（缓存 + 并发 2）并解码成 PCM
  const pcms = new Array(beats.length);
  const warnings = [];
  let synthesized = 0, cached = 0;
  await pool(beats.map((b, i) => async () => {
    const spoken = applyGlossary(b.say ?? b.text, glossary);
    if (provider === 'silent') { pcms[i] = silence(estimateSeconds(spoken, c.speed)); return; }
    const voice = voiceOf(b);
    const key = createHash('sha1')
      .update(JSON.stringify([provider, c.model, voice, c.speed, c.language_boost, c.stability, c.similarity_boost, spoken]))
      .digest('hex').slice(0, 16);
    const file = path.join(CACHE, `${provider}-${key}.mp3`);
    // 合成结果比字数预期长很多，通常是 TTS 多读了内容（ElevenLabs 对很短的文本偶尔会这样）。
    // agent 听不到声音，所以靠时长兜底：新合成的异常就重合成一次，仍异常则警告。
    const limit = estimateSeconds(spoken, c.speed) * 1.8 + 0.8;
    const fresh = async () => {
      await writeFile(file, await withRetry(() => providers[provider](spoken, { ...c, voice }), `beat ${b.id}`));
      synthesized++;
      console.log(`  合成 ${b.id}（${spoken.length} 字）`);
      return decodePcm(file);
    };
    let pcm;
    if (existsSync(file)) { cached++; pcm = await decodePcm(file); } else {
      pcm = await fresh();
      if (pcm.length / 2 / SR > limit) {
        console.warn(`  ${b.id} 时长 ${(pcm.length / 2 / SR).toFixed(2)}s 超出预期（上限 ${limit.toFixed(2)}s），重合成一次`);
        pcm = await fresh();
      }
    }
    const dur = pcm.length / 2 / SR;
    if (dur > limit) warnings.push(`${b.id}：时长 ${dur.toFixed(2)}s，按字数预期不超过 ${limit.toFixed(2)}s，可能多读或停顿异常，请人工试听`);
    const n = normalize(pcm, base.targetDb ?? -16);
    if (flags.verbose) console.log(`  ${b.id} 原始 ${n.level?.toFixed(1)} dB，增益 ${n.gain >= 0 ? '+' : ''}${n.gain.toFixed(1)} dB${n.limited > 0.05 ? `，峰值限幅最多 ${n.limited.toFixed(1)} dB` : ''}`);
    pcms[i] = n.pcm;
  }), 2);

  // 2) 拼接：开头留白 + 每个 beat + beat 后停顿；同时生成时间轴和字幕
  const leadIn = base.leadIn ?? 0.3;
  const chunks = [silence(leadIn)];
  const timelineBeats = [], cues = [];
  let cursor = leadIn;
  beats.forEach((b, i) => {
    const start = cursor;
    const end = start + pcms[i].length / 2 / SR;
    const speaker = dialog && b.speaker === 'b' ? { speaker: 'b' } : {};
    // 无配音时播放器用浏览器朗读：读法和字幕不同（say、发音词表）就把读法也写进时间轴
    const spoken = applyGlossary(b.say ?? b.text, glossary);
    const say = provider === 'silent' && spoken !== b.text ? { say: spoken } : {};
    timelineBeats.push({ id: b.id, start: r3(start), end: r3(end), text: b.text, ...say, ...speaker });
    cues.push(...makeCues(b.text, start, end).map(cue => ({ ...cue, ...speaker })));
    const pause = i === beats.length - 1 ? 0.6 : (b.pauseAfter ?? base.pauseAfterBeat ?? 0.35);
    chunks.push(pcms[i], silence(pause));
    cursor = end + pause;
  });

  await mkdir(outDir, { recursive: true });
  const audioFile = path.join(outDir, 'audio.mp3');
  if (provider === 'silent') await rm(audioFile, { force: true }); // 无配音：播放器按 timeline 计时，旧的音频删掉免得对不上
  else await ffmpeg(['-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '96k', '-y', audioFile],
    Buffer.concat(chunks));
  const timeline = { version: 1, provider, voice: main ?? null, ...(dialog ? { voiceB: other } : {}), speed: c.speed, duration: r3(cursor), beats: timelineBeats, cues };
  await writeFile(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');

  const rel = p => path.relative(ROOT, p).replaceAll('\\', '/');
  console.log(`✓ ${beats.length} 个 beat（新合成 ${synthesized}，缓存 ${cached}）→ ${provider === 'silent' ? `${rel(path.join(outDir, 'timeline.json'))}（无配音）` : rel(audioFile)}，时长 ${timeline.duration.toFixed(1)}s，声音 ${main ?? '（无）'}${dialog ? (main ? ` + ${other}（对话）` : '（对话）') : ''}`);
  for (const b of timelineBeats) console.log(`  ${b.id.padEnd(14)} ${b.start.toFixed(2).padStart(7)} – ${b.end.toFixed(2)}`);
  for (const w of warnings) console.warn(`⚠ ${w}`);
}

// ---------- 列出声音 ----------

async function listVoices(provider, keyword) {
  let list;
  if (provider === 'minimax') {
    const host = process.env.MINIMAX_API_HOST || 'https://api.minimax.io';
    const res = await fetch(`${host}/v1/get_voice`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${need('MINIMAX_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_type: 'system' }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || (j.base_resp && j.base_resp.status_code !== 0)) {
      throw new Error(`MiniMax HTTP ${res.status} ${j.base_resp?.status_msg ?? ''}`);
    }
    list = (j.system_voice || []).map(v => ({ id: v.voice_id, name: v.voice_name, desc: [].concat(v.description || []).join(' ') }));
  } else if (provider === 'elevenlabs') {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': need('ELEVENLABS_API_KEY') } });
    if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    list = (j.voices || []).map(v => ({
      id: v.voice_id,
      name: v.name,
      desc: [v.category, ...Object.values(v.labels || {}), (v.verified_languages || []).map(l => l.language).join(',')]
        .filter(Boolean).join(' / '),
    }));
  } else {
    throw new Error('用法：node tools/tts.mjs voices <minimax|elevenlabs> [关键词]');
  }
  const kw = keyword?.toLowerCase();
  const shown = kw ? list.filter(v => `${v.id} ${v.name} ${v.desc}`.toLowerCase().includes(kw)) : list;
  for (const v of shown) console.log(`${v.id}\t${v.name}\t${v.desc}`);
  console.log(`（共 ${shown.length} / ${list.length} 个）`);
}

// ---------- 设计声音（MiniMax voice design） ----------
// 只生成试听音频；设计出的 voice_id 第一次用于正式合成时，MiniMax 会收一次性费用（2026-10 官方价 $3/个）。

async function designVoice(prompt, flags) {
  if (!prompt || !flags.text || !flags.out) throw new Error('用法：node tools/tts.mjs design "<声音描述>" --text "<试听文本>" --out <试听.mp3>');
  const host = process.env.MINIMAX_API_HOST || 'https://api.minimax.io';
  const res = await fetch(`${host}/v1/voice_design`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('MINIMAX_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, preview_text: flags.text }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.base_resp?.status_code !== 0 || !j.trial_audio) {
    throw new Error(`MiniMax voice_design HTTP ${res.status} code=${j.base_resp?.status_code} ${j.base_resp?.status_msg ?? ''}`);
  }
  const out = path.resolve(flags.out);
  await mkdir(path.dirname(out), { recursive: true });
  const raw = `${out}.raw`;
  await writeFile(raw, Buffer.from(j.trial_audio, 'hex'));
  await ffmpeg(['-i', raw, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', '-y', out]); // 统一转成 mp3
  await import('node:fs/promises').then(fs => fs.rm(raw));
  console.log(`✓ voice_id ${j.voice_id} → ${path.relative(ROOT, out).replaceAll('\\', '/')}`);
}

// ---------- 入口 ----------

const { pos, flags } = parseArgs(process.argv.slice(2));
try {
  if (pos[0] === 'voices') await listVoices(pos[1], pos[2]);
  else if (pos[0] === 'design') await designVoice(pos[1], flags);
  else if (pos[0]) await synthesize(path.resolve(pos[0]), flags);
  else { console.log(USAGE); process.exit(1); }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
