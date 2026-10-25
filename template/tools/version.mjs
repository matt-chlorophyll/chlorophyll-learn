#!/usr/bin/env node
// version.mjs — 检查 Chlorophyll-Learn 有没有新版本（/today 开头运行）
// 比较这个工作区的版本（.chlorophyll/install.json）和插件仓库默认分支上的版本（GitHub 上的 .claude-plugin/plugin.json）。
// - 一天最多联网查一次，结果记在 .cache/version-check.json；同一个新版本只提醒一次
// - 只读版本号，不发送任何学习数据；联网失败就什么都不说
// - .env 里写 UPDATE_CHECK=0 就不检查
// 用法：node tools/version.mjs            有新版本时输出提醒，否则没有输出
//      node tools/version.mjs --force    忽略缓存和"已提醒过"，重新查并输出结果

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, '.chlorophyll', 'install.json');
const CACHE = path.join(ROOT, '.cache', 'version-check.json'); // .cache/ 不进 git
const DAY = 20 * 3600 * 1000; // 每天在差不多的时间上课，留点余量
const force = process.argv.includes('--force');

if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
if (process.env.UPDATE_CHECK === '0' && !force) process.exit(0);

const read = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const install = read(STATE);
const current = install?.version;
const repo = /github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?$/.exec(install?.repository ?? '')?.[1];
if (!current || !repo) {
  if (force) console.log('不知道这个工作区的版本或插件仓库（.chlorophyll/install.json），运行一次 /chlorophyll-learn:setup 就有了。');
  process.exit(0);
}

// 版本号比较：0.1.10 > 0.1.9
const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

const cache = (!force && read(CACHE)) || {};
let latest = cache.latest;
if (force || !cache.checkedAt || Date.now() - Date.parse(cache.checkedAt) > DAY) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/plugin.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = (await res.json()).version;
    cache.checkedAt = new Date().toISOString();
    cache.latest = latest;
  } catch (e) {
    if (force) console.log(`查不到最新版本（${e.message}），先跳过。`);
    process.exit(0);
  }
}

if (latest && newer(latest, current) && (force || cache.notified !== latest)) {
  console.log(`Chlorophyll-Learn 有新版本 ${latest}（这个工作区是 ${current}）。更新分两步：`);
  console.log('1. 更新插件：在终端里运行 claude plugin marketplace update chlorophyll 和 claude plugin update chlorophyll-learn@chlorophyll，然后重启 Claude Code');
  console.log('2. 更新工作区：在这个工作区里运行 /chlorophyll-learn:setup（不碰学习记录和课程）');
  cache.notified = latest;
} else if (force) console.log(`已经是最新版本 ${current}${latest && latest !== current ? `（仓库上是 ${latest}）` : ''}。`);
mkdirSync(path.dirname(CACHE), { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache, null, 2) + '\n');
