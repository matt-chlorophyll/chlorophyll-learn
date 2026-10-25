#!/usr/bin/env node
// setup.mjs — 把 template/ 复制成学习工作区，或者更新已有工作区的平台文件（/chlorophyll-learn:setup 调用）
//
// 用法：node scripts/setup.mjs <工作区目录> [--force] [--check]
//   第一次：复制全部文件，生成 .env，记下每个平台文件的指纹（.chlorophyll/install.json）。
//   再次运行：只更新平台文件。学习记录、课程、manifest、你的设置（tts.json、发音词表、settings.json）不动。
//            你改过的平台文件先备份到 .chlorophyll/backup/<时间>/ 再覆盖；模板里删掉的平台文件，没改过的才删。
//   --force：目录不是空的、也不是 Chlorophyll-Learn 工作区时，照样安装（会覆盖同名的文件）。
//   --check：只检查环境，不复制文件。
// 最后一行输出 JSON 摘要，给 setup skill 读。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(PLUGIN, 'template');
const { version: VERSION, repository: REPOSITORY } = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));

const args = process.argv.slice(2);
const flag = f => args.includes(`--${f}`);
const targetArg = args.find(a => !a.startsWith('--'));
if (!targetArg) { console.log('用法：node scripts/setup.mjs <工作区目录> [--force] [--check]'); process.exit(1); }
const target = path.resolve(targetArg);

// 种子文件：工作区里没有时才创建，之后归学习者所有，更新时不覆盖
const SEED = [
  /^learner\//, /^curriculum\//,
  /^site\/manifest\.json$/, /^site\/map\.json$/,
  /^platform\/(pronunciation\.md|tts\.json|build-log\.md)$/,
  /^\.claude\/settings\.json$/,
  /^gitignore$/,
];
const SKIP_DIRS = new Set(['.tmp', '.cache', 'node_modules', '.git']);
const destOf = rel => (rel === 'gitignore' ? '.gitignore' : rel); // npm 发布会吞掉 .gitignore，所以模板里不带点
const isSeed = rel => SEED.some(re => re.test(rel));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), base, out); }
    else out.push(path.relative(base, path.join(dir, e.name)).replaceAll('\\', '/'));
  }
  return out;
}

function copy(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

// .claude/settings.json 是种子文件，但新版本加的权限设置要带给老用户：只补模板这次新加的 allow 条目和 defaultMode。
// install.json 记着上次装进来的模板设置，学习者自己删掉的条目不会被加回来（从没有这份记录的 0.1.0 更新时，模板里有、工作区里没有的都补上）
const SETTINGS = '.claude/settings.json';
const templatePerms = () => JSON.parse(readFileSync(path.join(TEMPLATE, SETTINGS), 'utf8')).permissions ?? {};
function mergeSettings(seeded) {
  const abs = path.join(target, SETTINGS);
  let cur;
  try { cur = JSON.parse(readFileSync(abs, 'utf8')); } catch { return null; } // 不是合法的 JSON：不动它
  if (cur?.constructor !== Object || (cur.permissions ?? {}).constructor !== Object || !Array.isArray(cur.permissions?.allow ?? [])) return null; // 结构不对：也不动
  const tpl = templatePerms(), perms = (cur.permissions ??= {}), allow = (perms.allow ??= []);
  const added = (tpl.allow ?? []).filter(r => !seeded?.allow?.includes(r) && !allow.includes(r));
  allow.push(...added);
  if (tpl.defaultMode && !seeded?.defaultMode && !perms.defaultMode) {
    perms.defaultMode = tpl.defaultMode;
    added.push(`defaultMode: ${tpl.defaultMode}`);
  }
  if (added.length) writeFileSync(abs, JSON.stringify(cur, null, 2) + '\n');
  return added;
}

// ---------- 环境检查 ----------

function run(cmd, a) {
  // 整条命令交给 shell：Windows 上 claude 是 .cmd 包装，要经过 cmd 才找得到；参数都是写死的常量
  const r = spawnSync([cmd, ...a].join(' '), { encoding: 'utf8', shell: true, windowsHide: true, timeout: 20000 });
  return r.status === 0 ? (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] : null;
}

async function checkEnv(ws) {
  const env = {};
  env.node = { ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.versions.node };
  env.claude = { ok: !!run('claude', ['--version']), version: run('claude', ['--version']) };
  env.ffmpeg = { ok: !!run('ffmpeg', ['-version']) };
  env.git = { ok: !!run('git', ['--version']), repo: existsSync(path.join(ws, '.git')) };
  try {
    const lib = existsSync(path.join(ws, 'tools/lib/chrome.mjs')) ? path.join(ws, 'tools/lib/chrome.mjs') : path.join(TEMPLATE, 'tools/lib/chrome.mjs');
    const { findChrome } = await import(pathToFileURL(lib).href);
    env.browser = { ok: true, path: findChrome() };
  } catch (e) { env.browser = { ok: false, error: e.message }; }
  const dotenv = path.join(ws, '.env');
  const vars = existsSync(dotenv) ? Object.fromEntries(readFileSync(dotenv, 'utf8').split(/\r?\n/).map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(m => [m[1], m[2]])) : {};
  env.tts = { ok: !!(vars.MINIMAX_API_KEY || vars.ELEVENLABS_API_KEY), minimax: !!vars.MINIMAX_API_KEY, elevenlabs: !!vars.ELEVENLABS_API_KEY };
  return env;
}

// ---------- 安装 / 更新 ----------

const summary = { target, version: VERSION, mode: null, created: [], updated: [], backedUp: [], keptLocal: [], removed: [], keptModified: [], seedsKept: 0, settingsAdded: [], backupDir: null };

if (!flag('check')) {
  if (!existsSync(TEMPLATE)) throw new Error(`插件里找不到模板：${TEMPLATE}`);
  const stateFile = path.join(target, '.chlorophyll', 'install.json');
  const prev = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  const nonEmpty = existsSync(target) && readdirSync(target).filter(n => !n.startsWith('.')).length > 0;
  if (!prev && nonEmpty && !flag('force')) {
    console.log(`✗ ${target} 不是空文件夹，也不是 Chlorophyll-Learn 工作区。换一个空文件夹，或者确认后加 --force（会覆盖同名文件）。`);
    console.log(JSON.stringify({ ...summary, mode: 'refused', reason: 'not-empty' }));
    process.exit(2);
  }
  summary.mode = prev ? 'update' : 'install';
  summary.from = prev?.version ?? null;
  const now = new Date(), p2 = n => String(n).padStart(2, '0'); // 备份目录用本地时间命名
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const backupDir = path.join(target, '.chlorophyll', 'backup', stamp);

  const files = {};
  for (const rel of walk(TEMPLATE)) {
    const src = path.join(TEMPLATE, rel);
    const dest = destOf(rel);
    const abs = path.join(target, dest);
    const seed = isSeed(rel);
    if (!existsSync(abs)) {
      copy(src, abs);
      summary.created.push(dest);
    } else if (seed) {
      summary.seedsKept++;
    } else {
      // files 里记的是上次装进来的模板版本：和工作区现在的比，看学习者或老师改没改过；和新模板比，看这次插件改没改这个文件
      const cur = sha(abs), next = sha(src), installed = prev?.files?.[dest];
      const localChanged = cur !== installed, templateChanged = next !== installed;
      if (cur !== next && localChanged && !templateChanged) {
        summary.keptLocal.push(dest); // 你改过、新版本也没改：保留你的版本
        files[dest] = installed;
        continue;
      }
      if (cur !== next) {
        if (localChanged) { // 你改过、新版本也改了：先备份你的版本再覆盖
          copy(abs, path.join(backupDir, dest));
          summary.backedUp.push(dest);
          summary.backupDir = path.relative(target, backupDir).replaceAll('\\', '/');
        }
        copy(src, abs);
        summary.updated.push(dest);
      }
    }
    if (!seed) files[dest] = sha(src);
  }

  // 新版本模板里没有了的平台文件：没改过就删掉，改过的留着并报告
  for (const [dest, h] of Object.entries(prev?.files ?? {})) {
    if (files[dest]) continue;
    const abs = path.join(target, dest);
    if (!existsSync(abs)) continue;
    if (sha(abs) === h) { rmSync(abs); summary.removed.push(dest); } else summary.keptModified.push(dest);
  }

  if (prev && !summary.created.includes(SETTINGS)) summary.settingsAdded = mergeSettings(prev.settings);

  if (!existsSync(path.join(target, '.env')) && existsSync(path.join(target, '.env.example'))) {
    copyFileSync(path.join(target, '.env.example'), path.join(target, '.env'));
    summary.created.push('.env');
  }
  if (process.platform !== 'win32') { try { chmodSync(path.join(target, 'start.sh'), 0o755); } catch { /* 没有就算了 */ } }

  mkdirSync(path.dirname(stateFile), { recursive: true });
  const settings = summary.settingsAdded === null ? prev?.settings : templatePerms(); // 没补成：留着旧记录，下次更新再补
  writeFileSync(stateFile, JSON.stringify({ version: VERSION, repository: REPOSITORY, installedAt: prev?.installedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), files, settings }, null, 2) + '\n');
}

summary.env = await checkEnv(target);

// ---------- 报告 ----------
const e = summary.env;
const mark = ok => (ok ? '✓' : '✗');
if (summary.mode === 'install') console.log(`✓ 已在 ${target} 建好学习工作区（Chlorophyll-Learn ${VERSION}，${summary.created.length} 个文件）`);
if (summary.mode === 'update') {
  console.log(`✓ 已更新 ${target}：${summary.from ?? '?'} → ${VERSION}，更新 ${summary.updated.length} 个、新增 ${summary.created.length} 个、删除 ${summary.removed.length} 个平台文件；学习记录和课程没动`);
  if (summary.keptLocal.length) console.log(`  你改过、新版本没改的 ${summary.keptLocal.length} 个文件保留了你的版本：${summary.keptLocal.join('、')}`);
  if (summary.backedUp.length) console.log(`  你改过、新版本也改了的 ${summary.backedUp.length} 个文件换成了新版本，你的版本备份在 ${summary.backupDir}/：${summary.backedUp.join('、')}`);
  if (summary.keptModified.length) console.log(`  新版本不再需要、但你改过的文件（留着没删）：${summary.keptModified.join('、')}`);
  if (summary.settingsAdded?.length) console.log(`  ${SETTINGS} 补上了新版本的权限设置：${summary.settingsAdded.join('、')}`);
  if (summary.settingsAdded === null) console.log(`  ${SETTINGS} 格式不对（不是合法的 JSON，或者 permissions.allow 不是数组），没有补上新版本的权限设置`);
}
console.log('环境：');
console.log(`  ${mark(e.node.ok)} Node.js ${e.node.version}${e.node.ok ? '' : '（需要 22 或更新）'}`);
console.log(`  ${mark(e.claude.ok)} Claude Code${e.claude.ok ? ` ${e.claude.version}` : '：命令行里找不到 claude，「问老师」会用不了'}`);
console.log(`  ${mark(e.browser.ok)} 浏览器${e.browser.ok ? `：${e.browser.path}` : `：${e.browser.error}`}`);
console.log(`  ${mark(e.ffmpeg.ok)} ffmpeg${e.ffmpeg.ok ? '' : '（可选：没有的话配音动画是字幕版，由浏览器朗读，也不能导出 mp4）'}`);
console.log(`  ${mark(e.tts.ok)} 配音 key${e.tts.ok ? `（${[e.tts.minimax && 'MiniMax', e.tts.elevenlabs && 'ElevenLabs'].filter(Boolean).join('、')}）` : '（可选：没有的话由浏览器朗读；想要更好的音质，在 .env 里填 MINIMAX_API_KEY 或 ELEVENLABS_API_KEY）'}`);
console.log(`  ${mark(e.git.ok)} git${e.git.ok ? (e.git.repo ? '（工作区已是 git 仓库）' : '（工作区还不是 git 仓库，可选）') : '（可选）'}`);
console.log(JSON.stringify({ ...summary, created: summary.created.length, updated: summary.updated.length }));
