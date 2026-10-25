#!/usr/bin/env node
// map-check.mjs — 检查 site/map.json 里一门课的迷雾地图数据（/build-week 第 4 步、/today 合完以后跑）
//
// 用法：node tools/map-check.mjs [<topic>] [选项]
//   例：node tools/map-check.mjs cooking
//   <topic>：课的 slug，默认 manifest 的 current.topic
//   --file <map.json>：要查的文件，默认 site/map.json
//   --manifest <manifest.json>：对照哪份 manifest 查"只放已开放的课"，默认 site/manifest.json
//   --build <build.json>：还没开放的一周，先在内存里按 /build-week 第 4 步的规则合进来再查，不写文件
//   --base <git 版本>：和哪一版的 site/map.json 比（已有地点的 kind、已有区域不能变），默认 HEAD
//   --base-file <map.json>：用一个文件当上一版；--no-base：不比
//   --self-test：跑 tools/fixtures/map-check/ 的样例：每份正好报出它 _expect 里写的错和警告，而且不打印名字
//   看某份样例报了什么：node tools/map-check.mjs cooking --file tools/fixtures/map-check/bad-links.json
//                         --manifest tools/fixtures/map-check/manifest.json --no-base
//
// 只打印计数和出错的 id，不打印地点名、概念名和来历。还没开放的课里的概念、地点用位置代替（"w3 d1 第 2 个"、
// "places[7]"），区域一律用位置（"regions[2]"）：主会话在开放前跑也不剧透。
// 有错误时退出码 1，只有警告是 0。规则见 platform/style-guide.md 第 10 节「迷雾地图的数据」。

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tools', 'fixtures', 'map-check');

const KINDS = { city: '城', canyon: '峡谷', ferry: '渡口', ruin: '遗迹' };
const LIMIT = { landmarkMin: 2, newPerWeek: 2, perKind: 3, traps: 2, lore: 40 };
const CONCEPT_ID = /^w(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACE_ID = /^p-[a-z0-9]+(?:-[a-z0-9]+)*$/;

// 每类问题一个代码，样例的 _expect 用它。landmark-small 对新地标是错误，对上一版就有的地标只是警告
const WHAT = {
  format: '字段缺了或类型不对',
  'dup-id': 'id 重复',
  'bad-id': 'id 的写法不对：概念 w<周>-<短名>（周和所在的周一致），地点 p-<短名>；小写字母、数字、连字符',
  'region-missing': 'region 不在 regions 里',
  'regions-changed': '上一版的区域顺序或 lanes 变了（新区域只能加在最后）',
  'link-missing': 'links 里有找不到的 id（列的是连出去的那个概念）',
  'link-later': 'links 指向后面的课',
  difficulty: 'difficulty 不是 1–5 的整数',
  'place-missing': '概念没写 place，或者 place 不在 places 里',
  'place-region': '概念和它的地点不在同一个区域',
  'place-empty': '地点里一个概念都没有',
  kind: 'kind 不是 city、canyon、ferry、ruin 之一',
  'kind-changed': '上一版就有的地点 kind 变了（开放后不再改）',
  trap: 'trap 不是 true，或者概念不在峡谷的地点里',
  'trap-many': `一个峡谷的 trap 多于 ${LIMIT.traps} 个`,
  'landmark-small': `地标的概念少于 ${LIMIT.landmarkMin} 个`,
  'landmark-week': `一周新出现的地标多于 ${LIMIT.newPerWeek} 个`,
  'landmark-kind': `同一种地标全图多于 ${LIMIT.perKind} 个`,
  moves: 'moves 不是 [地点 id, 地点 id] 的列表，或者地点找不到',
  unopened: 'manifest 还没开放的课出现在 map.json 里',
  'no-places': '没有 places（旧格式）：3D 地图会退回 2D；difficulty、place、trap 只查写了的',
  'no-map': 'manifest 开放了、map.json 里却没有地图的课',
  'place-removed': '上一版有的地点不见了（裁剪了课才会这样）',
  'label-changed': '上一版就有的地点 label 变了（只在 planner 明说改正时改）',
  'region-changed': '上一版就有的地点换了区域',
  'lore-long': `lore 超过 ${LIMIT.lore} 个字`,
};

const isStr = s => typeof s === 'string' && s.trim() !== '';
const isNum = n => typeof n === 'number' && Number.isFinite(n);
const isInt = n => Number.isInteger(n);

// ---------- 合并：/build-week 第 4 步的规则（只给 --build 用；地点没有概念时不丢掉，留给检查报出来） ----------
export function mergeBuild(map, b) {
  const m = structuredClone(map || {});
  m.topics ||= {};
  const t = (m.topics[b.topic] ||= { regions: structuredClone(b.regions || []), places: [], weeks: [] });
  t.regions ||= [];
  for (const r of b.regions || []) if (!t.regions.some(x => x?.id === r?.id)) t.regions.push(r);
  if (b.places) {
    t.places ||= [];
    for (const p of b.places) if (!t.places.some(x => x?.id === p?.id)) t.places.push(p);
  }
  const days = (b.days || []).map(d => ({ day: d.day, map: d.map }));
  t.weeks = (t.weeks || []).filter(w => w?.week !== b.week).concat({ week: b.week, days }).sort((x, y) => x.week - y.week);
  return m;
}

// ---------- 检查 ----------
// manifest：只有它开放了的课里的 id 能打印；opening：--build 的那一周（正要开放，不算 unopened，id 也不打印）
export function check(map, topic, { manifest = null, base = null, opening = null } = {}) {
  const errors = new Map(), warnings = new Map();
  const put = bag => (code, ref) => {
    if (!bag.has(code)) bag.set(code, []);
    if (ref != null && !bag.get(code).includes(ref)) bag.get(code).push(ref);
  };
  const err = put(errors), warn = put(warnings);
  const t = map?.topics?.[topic];
  if (!t || typeof t !== 'object') return { fatal: `map.json 里没有这门课：${topic}` };

  const opened = new Set((manifest?.topics?.[topic]?.weeks || []).flatMap(w => (w?.lessons || []).map(l => `w${w.week} d${l?.day}`)));
  const later = (a, b) => a.week > b.week || (a.week === b.week && a.day > b.day);

  // 区域：一律按位置打印
  const regions = Array.isArray(t.regions) ? t.regions : [];
  if (!regions.length) err('format', 'regions');
  const regionIds = new Set();
  regions.forEach((r, i) => {
    const at = `regions[${i}]`;
    if (!isStr(r?.id)) return err('format', `${at}.id`);
    if (regionIds.has(r.id)) err('dup-id', at);
    regionIds.add(r.id);
    if (!isStr(r.label)) err('format', `${at}.label`);
    if (r.lanes !== undefined && !(isInt(r.lanes) && r.lanes > 0)) err('format', `${at}.lanes`);
    if (r.home !== undefined && !(isNum(r.home?.x) && isNum(r.home?.y) && (r.home.ext === undefined || isNum(r.home.ext)))) err('format', `${at}.home`);
  });

  // 课和概念
  const lessons = [], concepts = new Map(), weekNos = new Set();
  if (!Array.isArray(t.weeks)) err('format', 'weeks');
  (Array.isArray(t.weeks) ? t.weeks : []).forEach((w, wi) => {
    if (!isInt(w?.week) || w.week < 0) return err('format', `weeks[${wi}].week`);
    if (weekNos.has(w.week)) return err('dup-id', `w${w.week}`);
    weekNos.add(w.week);
    if (!Array.isArray(w.days)) return err('format', `w${w.week}.days`);
    const dayNos = new Set();
    w.days.forEach((d, di) => {
      if (!isInt(d?.day) || d.day < 0) return err('format', `w${w.week}.days[${di}].day`);
      const key = `w${w.week} d${d.day}`;
      if (dayNos.has(d.day)) return err('dup-id', key);
      dayNos.add(d.day);
      const lesson = { week: w.week, day: d.day, key };
      lessons.push(lesson);
      if (!Array.isArray(d.map)) return err('format', `${key}.map`);
      d.map.forEach((c, i) => {
        const pos = `${key} 第 ${i + 1} 个`;
        if (!isStr(c?.id)) return err('format', `${pos}.id`);
        const ref = opened.has(key) ? c.id : pos;
        if (concepts.has(c.id)) return err('dup-id', ref);
        concepts.set(c.id, { c, ...lesson, ref });
      });
    });
  });

  // 地点（先收齐，打印要等知道里面有哪些概念）
  const v2 = t.places !== undefined;
  if (!v2) warn('no-places');
  else if (!Array.isArray(t.places)) err('format', 'places');
  const places = new Map();
  (Array.isArray(t.places) ? t.places : []).forEach((p, i) => {
    if (!isStr(p?.id)) return err('format', `places[${i}].id`);
    if (places.has(p.id)) return err('dup-id', `places[${i}]`);
    places.set(p.id, { p, i, members: [], traps: 0 });
  });

  let links = 0, traps = 0;
  for (const x of concepts.values()) {
    const { c, ref } = x;
    const m = c.id.match(CONCEPT_ID);
    if (!m || Number(m[1]) !== x.week) err('bad-id', ref);
    if (!isStr(c.label)) err('format', `${ref}.label`);
    if (!regionIds.has(c.region)) err('region-missing', ref);
    if (!Array.isArray(c.links)) err('format', `${ref}.links`);
    else for (const id of c.links) {
      const to = concepts.get(id);
      if (!to) err('link-missing', ref);
      else if (later(to, x)) err('link-later', `${ref} → ${to.ref}`);
      else links++;
    }
    if ((v2 || c.difficulty !== undefined) && !(isInt(c.difficulty) && c.difficulty >= 1 && c.difficulty <= 5)) err('difficulty', ref);
    const pl = places.get(c.place);
    if (v2 || c.place !== undefined) {
      if (!pl) err('place-missing', ref);
      else {
        pl.members.push(x);
        if (regionIds.has(c.region) && c.region !== pl.p.region) err('place-region', ref);
      }
    }
    if (c.trap !== undefined && c.trap !== false) {
      if (c.trap !== true || pl?.p.kind !== 'canyon') err('trap', ref);
      else { pl.traps++; traps++; }
    }
  }

  const pref = x => (x.members.some(m => opened.has(m.key)) ? x.p.id : `places[${x.i}]`);
  const baseT = base?.topics?.[topic] || null;
  const basePlaces = new Map((Array.isArray(baseT?.places) ? baseT.places : []).filter(p => isStr(p?.id)).map(p => [p.id, p]));
  const byKind = {}, byWeek = {};
  for (const x of places.values()) {
    const { p } = x, ref = pref(x);
    if (!PLACE_ID.test(p.id)) err('bad-id', ref);
    if (!isStr(p.label)) err('format', `${ref}.label`);
    if (!regionIds.has(p.region)) err('region-missing', ref);
    if (p.kind !== undefined && !KINDS[p.kind]) err('kind', ref);
    if (p.seed !== undefined && !isInt(p.seed)) err('format', `${ref}.seed`);
    if (p.lore !== undefined) {
      if (typeof p.lore !== 'string') err('format', `${ref}.lore`);
      else if ([...p.lore].length > LIMIT.lore) warn('lore-long', ref);
    }
    if (!x.members.length) { err('place-empty', ref); continue; }
    if (x.traps > LIMIT.traps) err('trap-many', ref);
    if (!KINDS[p.kind]) continue;
    if (x.members.length < LIMIT.landmarkMin) (basePlaces.has(p.id) ? warn : err)('landmark-small', ref);
    (byKind[p.kind] ||= []).push(ref);
    (byWeek[Math.min(...x.members.map(mb => mb.week))] ||= []).push(ref); // 地标算在它第一个概念的那一周
  }
  for (const refs of Object.values(byKind)) if (refs.length > LIMIT.perKind) refs.forEach(r => err('landmark-kind', r));
  for (const refs of Object.values(byWeek)) if (refs.length > LIMIT.newPerWeek) refs.forEach(r => err('landmark-week', r));

  if (t.moves !== undefined) {
    if (!Array.isArray(t.moves)) err('moves', 'moves');
    else t.moves.forEach((mv, i) => { if (!Array.isArray(mv) || mv.length !== 2 || !mv.every(id => places.has(id))) err('moves', `moves[${i}]`); });
  }

  // 只放已开放的课：manifest 没开放的课不能在 map.json 里（--build 的那一周除外）
  if (manifest) {
    for (const l of lessons) if (!opened.has(l.key) && l.week !== opening) err('unopened', l.key);
    const mapped = new Set(lessons.map(l => l.key));
    for (const k of opened) if (!mapped.has(k)) warn('no-map', k);
  }

  // 和上一版比：已有区域的顺序和 lanes、已有地点的 kind 不能变（上一版里的都开放过，id 可以打印）
  if (baseT) {
    (Array.isArray(baseT.regions) ? baseT.regions : []).forEach((r, i) => {
      const cur = regions[i];
      if (!cur || cur.id !== r?.id || (cur.lanes ?? 2) !== (r?.lanes ?? 2)) err('regions-changed', `regions[${i}]`);
    });
    for (const [id, bp] of basePlaces) {
      const x = places.get(id);
      if (!x) { warn('place-removed', id); continue; }
      if ((x.p.kind ?? null) !== (bp.kind ?? null)) err('kind-changed', id);
      if (x.p.label !== bp.label) warn('label-changed', id);
      if (x.p.region !== bp.region) warn('region-changed', id);
    }
  }

  const kinds = Object.fromEntries(Object.keys(KINDS).map(k => [k, 0]));
  let peaks = 0;
  for (const x of places.values()) if (KINDS[x.p.kind]) kinds[x.p.kind]++; else peaks++;
  const counts = {
    v2, regions: regions.length, places: places.size, peaks, kinds, concepts: concepts.size, lessons: lessons.length,
    weeks: [...weekNos].sort((a, b) => a - b), links, traps, basePlaces: baseT ? basePlaces.size : null,
  };
  return { errors, warnings, counts };
}

// ---------- 输出：只有计数和 id ----------
export function render(res, { head = '', baseLine = '' } = {}) {
  const out = head ? [head] : [];
  if (res.fatal) return [...out, `✗ ${res.fatal}`].join('\n');
  const c = res.counts;
  const lm = Object.entries(c.kinds).filter(([, n]) => n).map(([k, n]) => `${KINDS[k]} ${n}`).join('、');
  const span = c.weeks.length ? `第 ${c.weeks[0]}${c.weeks.length > 1 ? `–${c.weeks.at(-1)}` : ''} 周` : '没有周';
  const pl = c.v2 ? `地点 ${c.places}（峰 ${c.peaks}${lm ? `，地标 ${c.places - c.peaks}：${lm}` : ''}）` : '没有地点（旧格式）';
  out.push(`- 区域 ${c.regions}，${pl}，概念 ${c.concepts}，${c.lessons} 节课（${span}），连线 ${c.links}，trap ${c.traps}`);
  if (baseLine) out.push(`- ${baseLine}${c.basePlaces == null ? '' : `：上一版有地点 ${c.basePlaces} 个`}`);
  const short = refs => (refs.length > 12 ? `${refs.slice(0, 12).join('、')} …共 ${refs.length} 处` : refs.join('、'));
  const list = (bag, title) => {
    if (!bag.size) return;
    out.push(`${title} ${bag.size} 类：`);
    for (const [code, refs] of bag) out.push(`  - [${code}] ${WHAT[code]}${refs.length ? `（${refs.length}）：${short(refs)}` : ''}`);
  };
  list(res.errors, '✗ 错误');
  list(res.warnings, '⚠ 警告');
  if (!res.errors.size) out.push(res.warnings.size ? '✓ 没有错误（警告看一眼）' : '✓ 全过');
  return out.join('\n');
}

// ---------- 自测：tools/fixtures/map-check/ ----------
// 每份样例是一个 map.json，另加几个 _ 开头的字段：_note（坏在哪）、_expect（{ errors, warnings }：该报的代码）、
// _base（上一版用哪份样例）、_build（先合哪份 build-*.json）。manifest.json 是所有样例共用的
function selfTest() {
  const read = f => JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8'));
  const manifest = read('manifest.json');
  const files = readdirSync(FIXTURES).filter(f => f.endsWith('.json') && f !== 'manifest.json' && !f.startsWith('build-')).sort();
  const sorted = a => [...new Set(a)].sort().join('、') || '无';
  // 不能出现在输出里的：所有名字和来历；--build 那一周新加的 id
  const names = t => [...(t?.regions || []), ...(t?.places || []), ...(t?.weeks || []).flatMap(w => w.days.flatMap(d => d.map))]
    .flatMap(x => [x?.label, x?.lore]).filter(isStr);
  let ok = 0;
  console.log(`map-check 自测（tools/fixtures/map-check/，${files.length} 份）`);
  for (const f of files) {
    const fx = read(f), topic = Object.keys(fx.topics || {})[0];
    let map = fx, opening = null, hidden = [];
    if (fx._build) {
      const b = read(fx._build);
      map = mergeBuild(fx, b);
      opening = b.week;
      const before = new Set((fx.topics[b.topic]?.places || []).map(p => p.id));
      hidden = [...b.days.flatMap(d => d.map.map(c => c.id)), ...(b.places || []).map(p => p.id).filter(id => !before.has(id))];
    }
    const res = check(map, topic, { manifest, base: fx._base ? read(fx._base) : null, opening });
    const text = render(res);
    const want = { e: sorted(fx._expect?.errors || []), w: sorted(fx._expect?.warnings || []) };
    const got = res.fatal ? { e: res.fatal, w: '' } : { e: sorted([...res.errors.keys()]), w: sorted([...res.warnings.keys()]) };
    const leaks = [...names(map.topics?.[topic]), ...hidden].filter(s => text.includes(s)).length;
    if (want.e === got.e && want.w === got.w && !leaks) {
      ok++;
      console.log(`✓ ${f}：错误 ${got.e}；警告 ${got.w}`);
    } else {
      console.log(`✗ ${f}：应报 错误 ${want.e}；警告 ${want.w}`);
      console.log(`    实际 错误 ${got.e}；警告 ${got.w}${leaks ? `；输出里出现了 ${leaks} 处名字或没开放的 id` : ''}`);
    }
  }
  console.log(ok === files.length ? `✓ 自测 ${ok}/${files.length} 全过` : `✗ 自测 ${ok}/${files.length} 通过`);
  return ok === files.length;
}

// ---------- 命令行 ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const VALUED = ['--file', '--manifest', '--build', '--base', '--base-file'];
  const flag = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
  const rel = f => path.relative(process.cwd(), f).replaceAll('\\', '/') || f;
  const fail = msg => { console.log(`✗ ${msg}`); process.exit(2); };
  // 读不了只说哪个文件、什么原因：JSON.parse 的报错会带一段原文，不打印
  const readJson = (f, what) => {
    let s;
    try { s = readFileSync(f, 'utf8'); } catch (e) { fail(`读不了${what}：${rel(f)}（${e.code === 'ENOENT' ? '文件不存在' : e.code}）`); }
    try { return JSON.parse(s); } catch { fail(`${what}不是合法的 JSON：${rel(f)}`); }
  };

  if (argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

  const manifestFile = path.resolve(flag('manifest') || path.join(ROOT, 'site', 'manifest.json'));
  const manifest = readJson(manifestFile, ' manifest ');
  const build = flag('build') ? readJson(path.resolve(flag('build')), ' build.json ') : null;
  const topic = positional[0] || build?.topic || manifest?.current?.topic;
  if (!topic) fail('要给课的 slug：node tools/map-check.mjs <topic>');
  if (build && !isInt(build.week)) fail('build.json 里没有 week');
  if (build?.topic && build.topic !== topic) fail(`build.json 是 ${build.topic} 的，不是 ${topic} 的`);

  const file = path.resolve(flag('file') || path.join(ROOT, 'site', 'map.json'));
  let map = readJson(file, ' map.json ');
  if (build) map = mergeBuild(map, { ...build, topic });

  let base = null, baseLine;
  if (argv.includes('--no-base')) baseLine = '没和上一版比（--no-base）';
  else if (flag('base-file')) {
    base = readJson(path.resolve(flag('base-file')), ' --base-file ');
    baseLine = `和 ${rel(path.resolve(flag('base-file')))} 比`;
  } else {
    const ref = flag('base') || 'HEAD';
    try {
      const s = execFileSync('git', ['show', `${ref}:site/map.json`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
      base = JSON.parse(s);
      baseLine = `和 ${ref} 的 site/map.json 比`;
    } catch { baseLine = `${ref} 里没有 site/map.json，没和上一版比`; }
  }
  if (base && !base.topics?.[topic]) baseLine += '：上一版没有这门课';

  const what = build ? `${rel(file)} + 第 ${build.week} 周的 build.json（只在内存里合，没写文件）` : rel(file);
  const res = check(map, topic, { manifest, base, opening: build ? build.week : null });
  console.log(render(res, { head: `map-check ${topic}（${what}；对照 ${rel(manifestFile)}）`, baseLine }));
  process.exit(res.fatal ? 2 : res.errors.size ? 1 : 0);
}
