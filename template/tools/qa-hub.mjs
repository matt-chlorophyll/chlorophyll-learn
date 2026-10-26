#!/usr/bin/env node
// qa-hub.mjs — hub（首页的 3D 迷雾地图）的技术 QA：一条命令截图、查报错、查退路和几样行为，--self 再跑地图引擎的自检。
//
// 3D 地图要开 GPU 才画得出来，所以这里用本机的 Chrome 或 Edge 无头、开 GPU（tools/lib/chrome.mjs）。只用在 hub 上；课程页用 tools/qa.mjs。
//
// 用法：node tools/qa-hub.mjs [选项]
//   --port 4322          哪个端口的服务器（默认 .env 的 PORT 或 4321）；没开就在后台启动（和 qa.mjs 一样，之后一直运行）
//   --self               另外跑地图引擎的自检：只读 __check 的那几组（core、pg、deep、ring、stain、focus、drift），
//                        阈值和拨云设计系统自己的自检一样（下面的 R）。地名对比度（deep.labelContrast ≥ 4.5）在这里查
//   --themes a,b         只查这几个主题（默认六个：cn / mod / ani × light / dark）
//   --progress a,b       截图的进度（默认 all,none,part）：all 全打卡，none 一节没打卡，
//                        part 之前的周全打卡、本周只打卡第一节，今天当作本周第二节课那天（课程刚开始的样子）
//   --widths a,b         截图的宽（默认 1280,390）
//   --only a,b           只跑这几组：shots（截图）、behave（退路、减少动态效果、停、主题、面板和键盘、窄屏）、self、offline
//   --offline            另开一个只连得上本机的浏览器（假装断网）打开：除了字体，不能有报错
//   --out <目录>          截图和结果放哪（默认 .tmp/qa-hub/）
//   --lock <目录>         排队用的锁（默认 <系统临时目录>/boyun-map3d-gpu.lock）：同一台电脑上一次只开一个浏览器
// 截图：<out>/shots/<主题>-<进度>-<宽>.png（打开时看得见的那一屏），<主题>-part-<宽>-bottom.png（滚到底：本周的课、之前的周、页脚）；
//       behave/ 下是各项的截图。
// 结果：<out>/report.txt（一项一行：过 / 不过 / 已知 / 参考）、report.json。有报错、有不过（已知的除外）时退出码 1。
// 已知项（拨云的地图规矩里还没定下来的暂行项，列在报告里、不算不过）：tools/qa-hub.known.json。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep, withLock } from './lib/chrome.mjs';
import { ensureServer } from './lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--self' || a === '--offline') opt[a.slice(2)] = true;
  else if (a === '-h' || a === '--help') { const ls = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1); console.log(ls.slice(0, ls.findIndex(l => !l.startsWith('//'))).map(l => l.slice(3)).join('\n')); process.exit(0); }
  else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
  else { console.error(`不认识的参数：${a}（--help 看用法）`); process.exit(2); }
}
const PORT = Number(opt.port || process.env.PORT) || 4321;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const THEMES = (opt.themes || 'cn-light,cn-dark,mod-light,mod-dark,ani-light,ani-dark').split(',');
const PROGRESS = (opt.progress || 'all,none,part').split(',');
const WIDTHS = (opt.widths || '1280,390').split(',').map(Number);
const GROUPS = opt.only ? opt.only.split(',') : ['shots', 'behave', ...(opt.self ? ['self'] : []), ...(opt.offline ? ['offline'] : [])];
const OUT = path.resolve(opt.out || path.join(ROOT, '.tmp', 'qa-hub'));
const LOCK = opt.lock || path.join(os.tmpdir(), 'boyun-map3d-gpu.lock');
const KNOWN = JSON.parse(readFileSync(path.join(ROOT, 'tools', 'qa-hub.known.json'), 'utf8')).items || [];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

// 进度：和 ?dev=1 的 done / today 参数一一对应。part = 课程刚开始的样子（地点学了一部分、今晚有课），连上服务器以后按 manifest 算
const PROG = { all: 'done=all', none: 'done=none', part: 'done=none', fog: 'done=none&lmfog=1' };
async function partProgress() {
  const mf = await (await fetch(`${ORIGIN}/manifest.json`)).json().catch(() => null);
  const weeks = mf?.topics?.[mf?.current?.topic]?.weeks || [], cur = mf?.current?.week;
  const key = (w, l) => `w${String(w.week).padStart(2, '0')}d${l.day}`;
  const done = weeks.filter(w => w.week < cur).flatMap(w => w.lessons.map(l => key(w, l)));
  const now = weeks.find(w => w.week === cur)?.lessons || [];
  if (now[0]) done.push(key({ week: cur }, now[0]));
  const today = (now[1] || now[0])?.date;
  return `done=${done.length ? done.join(',') : 'none'}${/^\d{4}-\d\d-\d\d$/.test(today || '') ? `&today=${today}` : ''}`;
}
// 截图要稳定：云停在 0 秒、不飘，路上不流动，不读也不写“看过哪些”（每次都和第一次打开一样）
const STILL = 'dev=1&nostore=1&t=0&still=1&noflow=1';
const H_OF = w => (w < 600 ? 844 : 800);

// ---------- 阈值（和拨云设计系统自己的地图自检是同一套；拨云更新、改了规矩时一起改） ----------
const R = {
  fogOnLearned: 0, hitsMiss: 0,
  head: { body: 0.01, worst: 0.02, thinK: 2, mpkC: 0.02, bodyExc: { 'cn-light': { none: 0.02, fog: 0.02 } } },
  tnFogDE: 3, ringZero: ['topMist', 'topCloud', 'labMist', 'labCloud'], stainMax: 0.5, flickerMax: 3, peakInversions: 0,
  specks: 0, warm: { strips: 0, edges: 0, dusk: 2 }, hue: { chroma: 0.006, hue: 15 }, sat: { modP99: 0.13, nearAccent: 0.05 }, labelMin: 4.5,
};

// ---------- 结果 ----------
const rows = [];
const row = (group, name, item, value, pass, note = '') => rows.push({ group, name, item, value, pass, note });
const shots = [], requests = new Set(), perf = [];   // perf：每次打开时页头和地图第一帧的毫秒数

// ---------- 浏览器里的一页 ----------
async function openBrowser(args = []) {
  const profile = path.join(OUT, `profile-${process.pid}-${Date.now()}`);
  const chrome = await launchChrome(profile, { gpu: true, width: 1280, height: 800, args });
  const page = await chrome.newPage();
  const log = { errors: [], warnings: [] };
  page.on('Runtime.exceptionThrown', p => { const d = p.exceptionDetails; log.errors.push(`异常 ${(d.exception?.description || d.text || '').slice(0, 300)} @${(d.url || '').split('/').pop()}:${d.lineNumber}`); });
  page.on('Runtime.consoleAPICalled', p => {
    const s = p.args.map(a => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ').slice(0, 300);
    if (p.type === 'error') log.errors.push(`console.error ${s}`); else if (p.type === 'warning') log.warnings.push(s);
  });
  page.on('Log.entryAdded', p => { if (p.entry.level === 'error') log.errors.push(`${p.entry.text || ''} ${p.entry.url || ''}`.trim().slice(0, 300)); });
  page.on('Network.requestWillBeSent', p => requests.add(p.request.url));
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await page.send(m);
  const ev = async expr => { try { return await page.eval(expr); } catch (e) { log.errors.push(`（QA 脚本）${String(e.message).slice(0, 200)}`); return undefined; } };
  return {
    page, log, ev,
    async size(w, h = H_OF(w)) { await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); },
    async motion(v) { await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: v }] }); },
    // 打开一个地址，等地图画好（3D：__check 有了；2D：__hub.mode 是 2d）或者确定没有地图；再等字体
    async go(url, { wait = 1200 } = {}) {
      log.errors.length = 0; log.warnings.length = 0;
      await page.send('Page.navigate', { url });
      await sleep(400);
      for (let k = 0; k < 200; k++) {
        const st = await ev(`(function(){var h=window.__hub;if(!h||!h.mode)return 'wait';if(h.mode==='3d'&&!window.__check&&!window.__failed)return 'wait';return 'ok'})()`);
        if (st === 'ok') break;
        await sleep(150);
      }
      await ev('document.fonts ? document.fonts.ready.then(function () { return 1; }) : 1');
      await sleep(wait);
      return ev('JSON.stringify(window.__hub || null)').then(s => JSON.parse(s || 'null'));
    },
    async shot(file) {
      mkdirSync(path.dirname(file), { recursive: true });
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(r.data, 'base64');
      writeFileSync(file, buf);
      shots.push(path.relative(OUT, file).replaceAll('\\', '/'));
      return buf;
    },
    async key(k) {
      const code = { Enter: 'Enter', Escape: 'Escape', ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' }[k];
      const vk = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[k];
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    },
    async close() { await chrome.close(); for (let i = 0; i < 5; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(400); } } },
  };
}

// 页面上的几样东西（每次截图都看）：用 3D 还是 2D、页头第一个数字、今晚的入口、朱点几个、横向滚动、地标是不是都有种类、只放了已开放的周
const PAGE_FACTS = `JSON.stringify((function () {
  var I = window.BOYUN_MAP3D, cur = I && I.current.week, ui = window.MAP3 && MAP3.ui;
  var st = document.querySelector('#stats .by-stat');
  return {
    firstStat: st ? st.textContent.replace(/[\\d\\s/处]+/g, '') : null,
    tonight: (document.getElementById('tonight') || {}).textContent || '',
    focusDots: document.querySelectorAll('#over .focus-dot').length,
    next: window.MAP && MAP.progress ? MAP.progress().next : document.querySelector('#days li:not(.done):not(.weekend)') ? '（2D）' : null,
    hscroll: document.documentElement.scrollWidth - innerWidth,
    lmNoKind: ui && ui.places ? ui.places.filter(function (p) { return p.lm && !p.kindIn; }).map(function (p) { return p.id; }) : [],
    landmarks: ui && ui.places ? ui.places.filter(function (p) { return p.lm; }).length : 0,
    laterWeeks: I ? I.weeks.filter(function (w) { return w.week > cur; }).length + Object.keys(I.concepts).filter(function (k) { return I.concepts[k].week > cur; }).length : 0,
    firstGL: window.__check ? window.__check.firstGL : null,
    failed: window.__failed || null
  };
})())`;

// ---------- 截图 ----------
async function groupShots(B) {
  await B.motion('no-preference');
  for (const w of WIDTHS) {
    await B.size(w);
    for (const t of THEMES) for (const p of PROGRESS) {
      const name = `${t}-${p}-${w}`;
      const hub = await B.go(`${ORIGIN}/?${STILL}&theme=${t}&${PROG[p]}`);
      await B.shot(path.join(OUT, 'shots', `${name}.png`));
      if (p === 'part') {   // 再往下滚到底，看本周的课、周末、之前的周、页脚
        await B.ev('window.scrollTo(0, document.documentElement.scrollHeight), 1');
        await sleep(500);
        await B.shot(path.join(OUT, 'shots', `${name}-bottom.png`));
        await B.ev('window.scrollTo(0, 0), 1');
      }
      const f = JSON.parse((await B.ev(PAGE_FACTS)) || '{}');
      const errs = [...B.log.errors];
      row('shots', name, '页面报错', errs.length, errs.length === 0, errs.slice(0, 2).join(' | '));
      row('shots', name, '地图用 3D', `${hub?.mode}${hub?.why ? `（${hub.why}）` : ''}`, hub?.mode === '3d');
      row('shots', name, '页头第一个数字是“本周已打卡”', f.firstStat, f.firstStat === '本周已打卡');
      row('shots', name, '今晚的入口（有下一节课时“去上课”，都打卡了说一句）', f.tonight, f.next ? f.tonight.startsWith('去上课') : /打卡了/.test(f.tonight));
      if (hub?.mode === '3d') {   // 下面三项只有 3D 地图有
        row('shots', name, '朱点个数（有下一节课时 1 个，都打卡了 0 个）', `${f.focusDots}（下一节 ${f.next || '无'}）`, f.focusDots === (f.next ? 1 : 0));
        row('shots', name, '地标只在写了种类的地点', f.lmNoKind?.length ? f.lmNoKind.join(',') : `过（${f.landmarks} 个地标）`, !f.lmNoKind?.length);
        row('shots', name, '输入里只有已开放的周', f.laterWeeks, f.laterWeeks === 0);
      }
      if (w < 600) row('shots', name, '没有横向滚动', `多出 ${f.hscroll} px`, f.hscroll <= 0);
      console.log(`${name} ${hub?.mode} 首帧 ${f.firstGL} ms 页头 ${hub?.headAt} ms${errs.length ? ` 报错 ${errs.length}` : ''}`);
      perf.push({ name, firstGL: f.firstGL, headAt: hub?.headAt });
    }
  }
}

// ---------- 行为：退路、减少动态效果、停、主题、面板和键盘、窄屏 ----------
async function groupBehave(B) {
  const t = THEMES.includes('ani-dark') ? 'ani-dark' : THEMES[0], dir = path.join(OUT, 'behave');
  await B.motion('no-preference');
  await B.size(1280);
  const base = `${ORIGIN}/?${STILL}&theme=${t}&${PROG.part}`;
  const visible = id => `(function(){var e=document.getElementById('${id}');return !!e&&!e.hidden&&e.getBoundingClientRect().height>0})()`;

  // 2D 雾图在每个主题下的样子（?dev=1&map=2d）
  for (const th of THEMES) {
    const hub = await B.go(`${ORIGIN}/?${STILL}&theme=${th}&${PROG.part}&map=2d`, { wait: 1500 });
    await B.shot(path.join(dir, `2d-${th}.png`));
    row('behave', `2D 雾图 ${th}`, '画出来、没有报错', `${hub?.mode}，报错 ${B.log.errors.length}`, hub?.mode === '2d' && B.log.errors.length === 0, B.log.errors.slice(0, 2).join(' | '));
  }
  // 退路：?dev=1&map=2d（直接用 2D）、gl=0（假装没有 WebGL 2，由引擎调 onFail）、ctxlost=300（第一帧以后假装显卡把画布收回去）、map.json 没有 places
  for (const [name, q, why] of [['map2d', 'map=2d', 'dev'], ['gl0', 'gl=0', 'nowebgl2'], ['ctxlost', 'ctxlost=300', 'contextlost']]) {
    let hub = await B.go(`${base}&${q}`);
    for (let k = 0; k < 40 && hub?.mode !== '2d'; k++) { await sleep(250); hub = JSON.parse((await B.ev('JSON.stringify(window.__hub)')) || 'null'); }
    await sleep(800);
    await B.shot(path.join(dir, `fallback-${name}.png`));
    const ok2d = await B.ev(visible('mapSec')), no3d = !(await B.ev(visible('hubMap')));
    const errs = [...B.log.errors];
    row('behave', `退路 ${name}`, '回到 2D 雾图', `${hub?.mode}（${hub?.why}）；2D ${ok2d ? '看得见' : '看不见'}，3D ${no3d ? '藏起来了' : '还在'}`, hub?.mode === '2d' && hub?.why === why && ok2d && no3d);
    row('behave', `退路 ${name}`, '页面报错', errs.length, errs.length === 0, errs.slice(0, 2).join(' | '));
  }
  {
    // map.json 里没有地点（旧格式）：用 CDP 拦下 /map.json，去掉 places 再交给页面（不改文件）
    await B.page.send('Fetch.enable', { patterns: [{ urlPattern: '*/map.json*', requestStage: 'Request' }] });
    const strip = async p => {
      const j = await (await fetch(`${ORIGIN}/map.json`)).json();
      for (const tp of Object.values(j.topics || {})) delete tp.places;
      await B.page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }], body: Buffer.from(JSON.stringify(j)).toString('base64') });
    };
    B.page.on('Fetch.requestPaused', p => { strip(p).catch(e => B.log.errors.push(`（QA 脚本）${e.message}`)); });
    const hub = await B.go(base);
    await B.shot(path.join(dir, 'fallback-noplaces.png'));
    const ok2d = await B.ev(visible('mapSec')), errs = [...B.log.errors];
    row('behave', '退路 noplaces', '回到 2D 雾图', `${hub?.mode}（${hub?.why}）；2D ${ok2d ? '看得见' : '看不见'}`, hub?.mode === '2d' && hub?.why === 'noplaces' && ok2d);
    row('behave', '退路 noplaces', '页面报错', errs.length, errs.length === 0, errs.slice(0, 2).join(' | '));
    await B.page.send('Fetch.disable');
  }

  // 云在飘：正常打开（不带 still），引擎在画；切到后台、滚出视口就停
  {
    await B.go(`${ORIGIN}/?dev=1&nostore=1&theme=${t}&${PROG.part}`, { wait: 2500 });
    const run0 = await B.ev('MAP3.ui.isRunning()');
    await B.ev(`(function(){Object.defineProperty(document,'hidden',{configurable:true,get:function(){return true}});Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'hidden'}});document.dispatchEvent(new Event('visibilitychange'));return 1})()`);
    await sleep(300);
    const runHidden = await B.ev('MAP3.ui.isRunning()');
    await B.ev(`(function(){delete document.hidden;delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));return 1})()`);
    await sleep(300);
    const runBack = await B.ev('MAP3.ui.isRunning()');
    await B.ev(`(function(){var d=document.createElement('div');d.style.height='3000px';document.body.appendChild(d);var r=document.getElementById('hubMap').getBoundingClientRect();window.scrollTo(0,r.bottom+window.scrollY+40);return 1})()`);
    await sleep(800);
    const runOut = await B.ev('MAP3.ui.isRunning()');
    row('behave', '云在飘', '正常打开时在画', run0, run0 === true);
    row('behave', '云在飘', '切到后台就停、回来接着画', `后台 ${runHidden}，回来 ${runBack}`, runHidden === false && runBack === true);
    row('behave', '云在飘', '滚出视口就停', runOut, runOut === false);
    row('behave', '云在飘', '页面报错', B.log.errors.length, B.log.errors.length === 0, B.log.errors.slice(0, 2).join(' | '));
  }

  // 减少动态效果：云不动、没有散雾动画（reveal=1 让最后一节打卡的课当成“新打卡的”）
  {
    await B.motion('reduce');
    await B.go(`${ORIGIN}/?dev=1&nostore=1&reveal=1&theme=${t}&${PROG.part}`, { wait: 1500 });
    const a = await B.shot(path.join(dir, 'reduced-1.png'));
    await sleep(2000);
    const b = await B.shot(path.join(dir, 'reduced-2.png'));
    const run = await B.ev('MAP3.ui.isRunning()'), revealed = await B.ev('window.__check && window.__check.revealed');
    row('behave', '减少动态效果', '云不动（不画循环、隔 2 秒两张截图一样）', `循环 ${run}，两张${a.equals(b) ? '一样' : '不一样'}`, run === false && a.equals(b));
    row('behave', '减少动态效果', '没有散雾动画', `revealed ${revealed}`, revealed === false);
    row('behave', '减少动态效果', '页面报错', B.log.errors.length, B.log.errors.length === 0, B.log.errors.slice(0, 2).join(' | '));
    await B.motion('no-preference');
  }

  // 面板和键盘：Tab 到一个地点，Enter 打开面板（按课分组、能点进那节课），方向键换地点，Esc 收起、焦点回到地点
  {
    await B.go(base);
    await B.ev(`(function(){var h=document.querySelector('#over .hit[data-id]');h.focus();return h.getAttribute('data-id')})()`);
    const id0 = await B.ev('document.activeElement && document.activeElement.getAttribute("data-id")');
    await B.key('Enter');
    await sleep(500);
    const pan = JSON.parse((await B.ev(`JSON.stringify((function(){var p=document.getElementById('panel');return {open:!p.hidden,groups:p.querySelectorAll('.cl li').length,links:[].map.call(p.querySelectorAll('.cl a'),function(a){return a.getAttribute('href')}),title:(p.querySelector('.by-panel__title')||{}).textContent}})())`)) || '{}');
    await B.shot(path.join(dir, 'panel-1280.png'));
    await B.key('Escape');
    await sleep(400);
    const closed = await B.ev('document.getElementById("panel").hidden'), back = await B.ev('document.activeElement && document.activeElement.getAttribute("data-id")');
    let moved = null;
    for (const k of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await B.key(k); await sleep(250);
      const id = await B.ev('document.activeElement && document.activeElement.getAttribute("data-id")');
      if (id && id !== back) { moved = `${k}：${back} → ${id}`; break; }
    }
    row('behave', '面板和键盘', 'Enter 打开面板，按课分组、能点进那节课', `${pan.open ? '打开' : '没打开'}，${pan.groups} 组，链接 ${(pan.links || []).join(' ')}`, pan.open && pan.groups > 0 && (pan.links || []).length > 0 && pan.links.every(h => /^\/lessons\//.test(h)));
    row('behave', '面板和键盘', 'Esc 收起，焦点回到地点', `${closed ? '收起了' : '没收起'}，焦点 ${back}（打开前 ${id0}）`, closed === true && back === id0);
    row('behave', '面板和键盘', '方向键换到别的地点', moved || '没动', !!moved);
    row('behave', '面板和键盘', '页面报错', B.log.errors.length, B.log.errors.length === 0, B.log.errors.slice(0, 2).join(' | '));
  }

  // 窄屏（390）：页面没有横向滚动，面板在下面（通栏的底部面板）
  {
    await B.size(390);
    await B.go(base);
    await B.ev(`(function(){var h=document.querySelector('#over .hit[data-id]');h.dispatchEvent(new MouseEvent('click',{bubbles:true}));return 1})()`);
    await sleep(600);
    const f = JSON.parse((await B.ev(`JSON.stringify((function(){var p=document.getElementById('panel'),r=p.getBoundingClientRect(),m=document.getElementById('map3d').getBoundingClientRect();return {open:!p.hidden,pos:getComputedStyle(p).position,top:Math.round(r.top),bottom:Math.round(r.bottom),vh:innerHeight,w:Math.round(r.width),mapTop:Math.round(m.top),hscroll:document.documentElement.scrollWidth-innerWidth}})())`)) || '{}');
    await B.shot(path.join(dir, 'panel-390.png'));
    row('behave', '窄屏 390', '面板在下面（底部通栏）', `${f.open ? '打开' : '没打开'}，${f.pos}，${f.top}–${f.bottom} / 视口 ${f.vh}，宽 ${f.w}`, f.open && f.pos === 'fixed' && Math.abs(f.bottom - f.vh) <= 2 && f.w >= 380);
    row('behave', '窄屏 390', '没有横向滚动（地图自己左右拖）', `多出 ${f.hscroll} px`, f.hscroll <= 0);
    row('behave', '窄屏 390', '页面报错', B.log.errors.length, B.log.errors.length === 0, B.log.errors.slice(0, 2).join(' | '));
    await B.size(1280);
  }

  // 主题：没选过时默认动画（5:00–17:00 晨，其余暮）；换笔墨整页重开、换晨暮页内重画，选过的记住；旧的值（cn-dark 这类）照旧认
  {
    const day = (h => (h >= 5 && h < 17 ? 'light' : 'dark'))(new Date().getHours());
    await B.go(`${ORIGIN}/`);
    await B.ev("localStorage.removeItem('lh:hub:theme'), 1");
    await B.go(`${ORIGIN}/`);
    const t0 = await B.ev('document.documentElement.dataset.theme');
    const origin0 = await B.ev('performance.timeOrigin');
    await B.ev(`document.querySelector('#segReg button[data-v="mod"]').click(), 1`);
    let o1 = origin0;
    for (let k = 0; k < 60 && o1 === origin0; k++) { await sleep(250); o1 = await B.ev('performance.timeOrigin'); }
    await B.go(`${ORIGIN}/`, { wait: 400 });   // 重开以后的那一页（地址还是 /），等它画好
    const t1 = await B.ev('document.documentElement.dataset.theme'), s1 = await B.ev("localStorage.getItem('lh:hub:theme')");
    const other = day === 'light' ? 'dark' : 'light';
    const origin1 = await B.ev('performance.timeOrigin');
    await B.ev(`document.querySelector('#segDay button[data-v="${other}"]').click(), 1`);
    await sleep(800);
    const t2 = await B.ev('document.documentElement.dataset.theme'), origin2 = await B.ev('performance.timeOrigin'), s2 = await B.ev("localStorage.getItem('lh:hub:theme')");
    await B.go(`${ORIGIN}/`);
    const t3 = await B.ev('document.documentElement.dataset.theme');
    await B.ev("localStorage.setItem('lh:hub:theme', 'cn-dark'), 1");
    await B.go(`${ORIGIN}/`);
    const t4 = await B.ev('document.documentElement.dataset.theme'), pressed = await B.ev(`[].map.call(document.querySelectorAll('.by-seg button[aria-pressed="true"]'),function(b){return b.textContent}).join('')`);
    await B.ev("localStorage.removeItem('lh:hub:theme'), 1");
    row('behave', '主题', '没选过：默认动画，按时间分晨暮', t0, t0 === `ani-${day}`);
    row('behave', '主题', '换笔墨：整页重开，记住', `${t1}（存了 ${s1}，${o1 !== origin0 ? '重开了' : '没重开'}）`, t1 === `mod-${day}` && s1 === t1 && o1 !== origin0);
    row('behave', '主题', '换晨暮：页内重画，记住', `${t2}（存了 ${s2}，${origin2 === origin1 ? '没重开' : '重开了'}）`, t2 === `mod-${other}` && s2 === t2 && origin2 === origin1);
    row('behave', '主题', '再打开还是选过的', t3, t3 === `mod-${other}`);
    row('behave', '主题', '旧的值照旧认（cn-dark = 中式暮）', `${t4}，按钮 ${pressed}`, t4 === 'cn-dark' && pressed === '中式暮');
  }
}

// ---------- 地图引擎的自检（--self） ----------
const ASYNC_DONE = "(function(c){if(!c)return 'no';var a=['drift','deep','focusCheck','ringCheck','stain','pgCheck'];for(var i=0;i<a.length;i++){if(c[a[i]]&&c[a[i]].done===false)return 'wait'}return 'ok'})(window.__check)";
async function groupSelf(B) {
  await B.motion('no-preference');
  await B.size(1280, 800);
  const res = {};
  const visit = async (t, name, q, js) => {
    await B.go(`${ORIGIN}/?${STILL}&theme=${t}&${q}`, { wait: 1500 });
    if (js) { await B.ev(js); await sleep(400); }
    for (let k = 0; k < 240 && (await B.ev(ASYNC_DONE)) === 'wait'; k++) await sleep(500);
    const check = JSON.parse((await B.ev('JSON.stringify(window.__check || null)')) || 'null');
    res[`${t}-${name}`] = { check, errors: [...B.log.errors] };
    console.log(`self ${t}-${name}${B.log.errors.length ? ` 报错 ${B.log.errors.length}` : ''}`);
  };
  let zat = null;
  for (const t of THEMES) {
    for (const p of ['part', 'all', 'none', 'fog']) await visit(t, p, PROG[p], 'MAP3.LM.selfChecks()');
    if (!zat) zat = await B.ev("(MAP3.LM && MAP3.LM.plans && MAP3.LM.plans[0] ? MAP3.LM.plans[0].p.id : '')");
    await visit(t, 'pg', 'pgcheck=1');
    if (zat) await visit(t, 'pg-z2', `pgcheck=1&zoom=2&zat=${zat}`);
    await visit(t, 'deep-part', `${PROG.part}&deep=1`);
    await visit(t, 'deep-all', 'done=all&deep=1');
    await visit(t, 'ring', `${PROG.part}&ringcheck=1`);
    await visit(t, 'stain', `${PROG.part}&staincheck=1`);
    await visit(t, 'focus', `${PROG.part}&focuscheck=1`);
    for (const z of [1, 2, 3]) await visit(t, `drift-${z}`, `${PROG.part}&drift=1${z > 1 ? `&zoom=${z}` : ''}`);
  }
  // 判（和拨云自己的地图自检同样的口径和名字）
  for (const t of THEMES) {
    const cn = t.startsWith('cn'), ani = t.startsWith('ani'), dark = t.endsWith('dark');
    const C = n => res[`${t}-${n}`]?.check;
    const errN = Object.entries(res).filter(([n]) => n.startsWith(`${t}-`)).reduce((s, [, r]) => s + r.errors.length, 0);
    row('self', t, '页面报错', errN, errN === 0, Object.entries(res).filter(([n, r]) => n.startsWith(`${t}-`) && r.errors.length).map(([n, r]) => `${n}: ${r.errors[0]}`).slice(0, 2).join(' | '));
    for (const p of ['part', 'all', 'none', 'fog']) {
      const c = C(p);
      if (!c) { row('self', t, `${p} 没拿到 __check`, null, false); continue; }
      row('self', t, `fogOnLearned（${p}）`, c.fogOnLearned, c.fogOnLearned === R.fogOnLearned);
      if (c.hits) row('self', t, `hits 点不中（${p}）`, c.hits.miss, c.hits.miss === R.hitsMiss);
      if (c.lmInk && typeof c.lmInk === 'object') row('self', t, `lmInk（${p}）`, c.lmInk.pass ? '过' : (c.lmInk.bad || []).slice(0, 2).join('；'), !!c.lmInk.pass);
      const hc = c.headCheck;
      if (hc && typeof hc === 'object') {
        const lim = (R.head.bodyExc[t] || {})[p] || R.head.body, bad = [];
        for (const [lbl, r] of Object.entries(hc.places || {})) {
          if (r.body?.dL != null && Math.abs(r.body.dL) > lim + 1e-9) bad.push(`${lbl} 头 ${r.body.dL}`);
          if (r.worst && Math.abs(r.worst.dL) > R.head.worst + 1e-9) bad.push(`${lbl} 最差一件 ${r.worst.dL}`);
          if (r.thin?.k != null && r.thin.k > R.head.thinK) bad.push(`${lbl} 细的头 ×${r.thin.k}`);
          if (hc.mpk && r.body && r.body.C > R.head.mpkC) bad.push(`${lbl} 头 C ${r.body.C}`);
        }
        row('self', t, `headCheck（${p}）`, bad.length ? bad.join('；') : '过', !bad.length);
      } else if (typeof hc === 'string') row('self', t, `headCheck（${p}）`, hc, false);
      if (c.tnFog && typeof c.tnFog === 'object' && !c.tnFog.skip) row('self', t, `tnFog 今晚离雾（${p}）`, c.tnFog.dE, c.tnFog.dE >= R.tnFogDE);
      if (c.lmLabels && typeof c.lmLabels === 'object') row('self', t, `lmLabels（${p}）`, (c.lmLabels.bad || []).length, !(c.lmLabels.bad || []).length);
      if (c.r4 && typeof c.r4 === 'object') {
        row('self', t, `r4.pieces 部件连成一件（${p}）`, c.r4.pieces?.pass ? '过' : JSON.stringify(c.r4.pieces).slice(0, 160), !!c.r4.pieces?.pass);
        row('self', t, `r4.count 件数（${p}）`, c.r4.count?.pass ? '过' : JSON.stringify(c.r4.count).slice(0, 160), !!c.r4.count?.pass);
        row('self', t, `r4.orphans（${p}）`, c.r4.orphans?.n, c.r4.orphans?.n === 0);
      } else if (typeof c.r4 === 'string') row('self', t, `r4（${p}）`, c.r4, false);
    }
    for (const [n, k] of [['pg', '1×'], ['pg-z2', '2×']]) { const c = C(n); if (c?.pgCheck) row('self', t, `pgCheck（${k}）`, c.pgCheck.pass ? '过' : (c.pgCheck.fail || []).slice(0, 3).join('；'), !!c.pgCheck.pass); }
    for (const p of ['part', 'all']) {
      const d = C(`deep-${p}`)?.deep;
      if (!d) { row('self', t, `deep（${p}）没拿到`, null, false); continue; }
      if (d.error) row('self', t, `deep 出错（${p}）`, d.error, false);
      if (d.peakOrder) row('self', t, `deep.peakOrder 逆序（${p}）`, d.peakOrder.inversions, d.peakOrder.inversions === R.peakInversions);
      if (d.labelContrast) row('self', t, `deep.labelContrast 地名对比度最差（${p}）`, d.labelContrast.min, d.labelContrast.min >= R.labelMin, (d.labelContrast.below45 || []).slice(0, 3).join(' '));
      if (d.arrows) row('self', t, `deep.arrows 方向键（${p}）`, d.arrows.miss, d.arrows.miss === 0);
      if (cn) {
        if (d.specks) row('self', t, `deep.specks 孤立墨点（${p}）`, d.specks.n, d.specks.n === R.specks);
        if (d.warmEdge) { const lim = dark ? R.warm.dusk : 0; row('self', t, `deep.warmEdge 成条 / 成边（${p}）`, `${d.warmEdge.strips} / ${d.warmEdge.edges}`, d.warmEdge.strips <= Math.max(R.warm.strips, lim) && d.warmEdge.edges <= Math.max(R.warm.edges, lim)); }
        if (d.hueSpread) { const h = d.hueSpread; row('self', t, `deep.hueSpread（${p}）`, ['land', 'fog', 'water'].map(k => `${k} ${h[k].hue}° / ${h[k].chroma}`).join('，'), ['land', 'fog', 'water'].every(k => h[k].chroma <= R.hue.chroma && h[k].hue <= R.hue.hue)); }
      } else if (d.satChroma) {
        const s = d.satChroma;
        row('self', t, `deep.satChroma（${p}）`, `朱附近 p99 ${s.nearAccentP99}${ani ? '' : `，自然色 p99 ${s.p99}`}`, s.nearAccentP99 <= R.sat.nearAccent && (ani || s.p99 <= R.sat.modP99));
      }
    }
    { const r = C('ring')?.ringCheck; if (r) row('self', t, 'ringCheck', R.ringZero.map(k => `${k} ${r[k]}`).join('，'), R.ringZero.every(k => r[k] === 0)); }
    { const s = C('stain')?.stain; if (s) row('self', t, 'stain / flicker', `${s.stainMax}% / ${s.flickerMax}`, s.stainMax <= R.stainMax && s.flickerMax <= R.flickerMax); }
    { const f = C('focus')?.focusCheck; if (f) row('self', t, 'focusCheck 朱点和今晚的山顶不被云盖', f.error || f.max, !f.error && f.max === 0); }
    for (const z of [1, 2, 3]) { const d = C(`drift-${z}`)?.drift; if (d) row('self', t, `drift ${z}×`, d.error || `${d.outMax} / ${d.fullLeak}`, !d.error && d.outMax === 0 && d.fullLeak === 0); }
  }
}

// ---------- 第一次打开（新的浏览器，着色器、脚本都没缓存）：页头先出来，等地图的时候是雾、不白屏 ----------
// 开两次新的浏览器：第一次只计时（中间不去打扰页面），第二次在等地图的时候截图（截图本身会拖慢一点）
async function groupCold() {
  const t = THEMES.includes('ani-dark') ? 'ani-dark' : THEMES[0], dir = path.join(OUT, 'behave'), url = `${ORIGIN}/?dev=1&nostore=1&theme=${t}&${PROG.part}`;
  const STATE = `JSON.stringify({ head: window.__hub ? window.__hub.headAt : null, loading: !!document.querySelector('#hubMap.loading:not([hidden])'), gl: window.__check ? window.__check.firstGL : null })`;
  for (const pass of ['time', 'shots']) {
    const C = await openBrowser();
    try {
      await C.size(1280);
      await C.motion('no-preference');
      const state = async () => JSON.parse((await C.ev(STATE)) || 'null');
      await C.page.send('Page.navigate', { url });
      if (pass === 'time') {
        await sleep(3000);
        let st = await state();
        for (let k = 0; k < 120 && !st?.gl; k++) { await sleep(250); st = await state(); }
        row('behave', '第一次打开', '页头和本周的课 0.3 秒内出来（从打开页面算）', `${st?.head} ms`, st?.head != null && st.head <= 300);
        // 只作参考，不判过不过：无头 Chrome 的冷启动比有窗口的真浏览器慢一截（同一台电脑上约慢 1–2 秒），机器忙不忙也差一两秒
        row('behave', '第一次打开', '地图第一帧（从 __t0 算；新的浏览器、无头、像素比 1；目标 ≤ 10 秒，只作参考）', `${st?.gl} ms`, st?.gl == null ? false : null);
        perf.push({ name: 'cold', firstGL: st?.gl, headAt: st?.head });
      } else {
        let st = null;
        for (let k = 0; k < 150 && !st?.head; k++) { await sleep(40); st = await state(); }
        await C.shot(path.join(dir, 'cold-0-head.png'));
        await sleep(2000);
        const st2 = await state();
        await C.shot(path.join(dir, 'cold-1-wait.png'));
        for (let k = 0; k < 120 && !(await state())?.gl; k++) await sleep(250);
        await sleep(1500);
        await C.shot(path.join(dir, 'cold-2-ready.png'));
        row('behave', '第一次打开', '等地图的时候是雾（2 秒时）', `${st2?.loading ? '是雾' : '不是雾'}${st2?.gl ? `（第一帧已经画好：${st2.gl} ms）` : ''}`, !!(st2?.loading || st2?.gl));
      }
      row('behave', '第一次打开', `页面报错（${pass === 'time' ? '计时' : '截图'}那次）`, C.log.errors.length, C.log.errors.length === 0, C.log.errors.slice(0, 2).join(' | '));
    } finally { await C.close(); }
  }
}

// ---------- 断网（只连得上本机）：除了字体，0 报错 ----------
async function groupOffline() {
  const B = await openBrowser(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']);
  try {
    await B.size(1280);
    for (const t of ['ani-dark', 'cn-light']) {
      const hub = await B.go(`${ORIGIN}/?dev=1&theme=${t}&${PROG.part}`, { wait: 2000 });
      await B.shot(path.join(OUT, 'behave', `offline-${t}.png`));
      const fontErr = B.log.errors.filter(e => FONT_HOSTS.some(h => e.includes(h))), other = B.log.errors.filter(e => !FONT_HOSTS.some(h => e.includes(h)));
      row('offline', t, '只连得上本机：除了字体 0 报错', `${other.length}（字体 ${fontErr.length} 条）`, other.length === 0, other.slice(0, 2).join(' | '));
      row('offline', t, '地图照样是 3D', hub?.mode, hub?.mode === '3d');
    }
  } finally { await B.close(); }
}

// ---------- 防剧透：网络请求和数据里只有已开放的周 ----------
async function spoilerCheck() {
  const mf = await (await fetch(`${ORIGIN}/manifest.json`)).json();
  const md = await (await fetch(`${ORIGIN}/map.json`)).json().catch(() => null);
  const slug = mf.current?.topic, cur = mf.current?.week;
  const opened = new Set((mf.topics?.[slug]?.weeks || []).map(w => w.week));
  const later = (md?.topics?.[slug]?.weeks || []).filter(w => !opened.has(w.week) || w.week > cur).map(w => w.week);
  row('spoiler', 'map.json', '只有 manifest 开放了的周', later.length ? `多了第 ${later.join('、')} 周` : '过', later.length === 0);
  const bad = [...requests].filter(u => {
    const x = new URL(u);
    if (x.protocol === 'data:' || x.protocol === 'blob:') return false;
    if (FONT_HOSTS.includes(x.hostname)) return false;
    if (x.hostname !== '127.0.0.1' && x.hostname !== 'localhost') return true;
    const m = x.pathname.match(/^\/lessons\/[^/]+\/w(\d+)\//);
    return !!m && (Number(m[1]) > cur || !opened.has(Number(m[1])));
  });
  row('spoiler', '网络请求', '只请求本机和字体；课程页只到已开放的周', bad.length ? bad.slice(0, 3).join(' ') : `过（${requests.size} 个地址）`, bad.length === 0);
}

// ---------- 跑 ----------
const t0 = Date.now();
mkdirSync(OUT, { recursive: true });
for (const d of ['shots', 'behave']) if (GROUPS.includes(d)) rmSync(path.join(OUT, d), { recursive: true, force: true });   // 只清这次要重截的
let code = 0;
try {
  await ensureServer(ROOT, PORT);
  PROG.part = await partProgress();
  await withLock(LOCK, async () => {
    if (GROUPS.includes('behave')) await groupCold();
    const need = GROUPS.filter(g => g !== 'offline');
    if (need.length) {
      const B = await openBrowser();
      try {
        if (need.includes('shots')) await groupShots(B);
        if (need.includes('behave')) await groupBehave(B);
        if (need.includes('self')) await groupSelf(B);
      } finally { await B.close(); }
    }
    if (GROUPS.includes('offline')) await groupOffline();
  });
  await spoilerCheck();
} catch (e) {
  console.error(e);
  row('—', '—', 'QA 脚本出错', String(e.message || e), false);
}

for (const r of rows) {
  const k = r.pass === false && KNOWN.find(k => (k.theme === '*' || k.theme === r.name) && r.item.startsWith(k.item));
  if (k) { r.pass = 'known'; r.note = (r.note ? `${r.note}；` : '') + `已知：${k.why}`; }
}
const fail = rows.filter(r => r.pass === false), known = rows.filter(r => r.pass === 'known');
const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v));
const pv = perf.filter(p => p.firstGL != null);
const head = [
  `hub QA：${ORIGIN}/（${GROUPS.join('、')}；${((Date.now() - t0) / 60e3).toFixed(1)} 分钟）`,
  `${rows.length} 项：过 ${rows.filter(r => r.pass === true).length}，不过 ${fail.length}，已知 ${known.length}，参考 ${rows.filter(r => r.pass === null).length}`,
  pv.length ? `截图那几次：页头和本周的课 ${Math.min(...pv.map(p => p.headAt))}–${Math.max(...pv.map(p => p.headAt))} ms，地图第一帧 ${Math.min(...pv.map(p => p.firstGL))}–${Math.max(...pv.map(p => p.firstGL))} ms（同一个浏览器里连着开，第一次是冷的）` : '',
  `截图：${OUT}（${shots.length} 张）`,
].filter(Boolean);
const lines = [...head, '', ...rows.map(r => `${r.pass === true ? '过  ' : r.pass === 'known' ? '已知' : r.pass === null ? '参考' : '不过'}  [${r.group}] ${r.name} · ${r.item}：${fmt(r.value)}${r.note ? `  ${r.note}` : ''}`)];
writeFileSync(path.join(OUT, 'report.txt'), lines.join('\n') + '\n');
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ origin: ORIGIN, groups: GROUPS, rows, perf, shots }, null, 1));
console.log(head.join('\n'));
if (fail.length) { console.log('不过的：'); for (const r of fail) console.log(`  [${r.group}] ${r.name} · ${r.item}：${fmt(r.value)}${r.note ? `  ${r.note}` : ''}`); code = 1; }
console.log(`详细：${path.join(OUT, 'report.txt')}`);
process.exit(code);
