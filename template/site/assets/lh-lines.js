// lh-lines.js — 摘自仓库文件的代码片段：标出文件名，左边显示它在原文件里的行号
//
// 课件写法（规则见 platform/style-guide.md「代码片段的出处和行号」）：
//   <pre data-src="tools/serve.mjs" data-lines="70-78,90-95"><code>…</code></pre>
// data-lines 按片段里的顺序写原文件的行号段。表示省略的行不编号：只有省略号（…、……、...），
// 或者以省略号开头的注释（// …… 中间省略了什么）；其余每行依次取下一个行号。
// 原文件的一长行在片段里折成几行时，这一行的行号重复写（"137,137"），折出来的行不显示行号。
// 行数对不上时不加行号（文件名照样显示），返回一句说明（lesson.js 记进 QA 的 errors）。
// 课程页正文（lesson.js）和回看小窗（lh-recall.js）共用。

const SKIP = /^\s*(?:(?:\/\/|#)\s*(?:…+|\.{3,}).*|(?:…+|\.{3,})\s*)$/;
export const CODE_BLOCKS = 'pre[data-src], pre[data-lines]';

// "70-78,90-95" → [70…78, 90…95]；写法不对返回 null
function expand(spec) {
  const out = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (b < a) return null;
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out.length ? out : null;
}

function el(tag, cls, text) {
  const x = document.createElement(tag);
  x.className = cls;
  x.textContent = text;
  return x;
}

// 给一个代码块加文件名和行号栏。成功返回 null，否则返回出错说明（不加行号）
export function numberLines(pre) {
  if (pre.querySelector(':scope > .lh-src, :scope > .lh-ln')) return null; // 加过了
  const code = pre.querySelector(':scope > code');
  if (!code) return '<pre> 里没有 <code>';
  const label = pre.dataset.src ? el('span', 'lh-src', pre.dataset.src) : null;
  if (label) pre.prepend(label);
  if (pre.dataset.lines === undefined) return null;
  const nums = expand(pre.dataset.lines);
  if (!nums) return `data-lines="${pre.dataset.lines}" 写法不对`;
  const marks = [];
  let i = 0, prev = null;
  code.textContent.replace(/\n$/, '').split('\n').forEach((line, k) => {
    // 省略号行，以及 <code> 后面紧跟换行时空出来的第一行：不编号
    if (SKIP.test(line) || (k === 0 && line === '')) { marks.push(''); return; }
    const n = nums[i++];
    marks.push(n === prev ? '' : String(n ?? '')); // 原文件的一长行折成几行（行号重复写）：只在第一行显示
    prev = n;
  });
  if (i !== nums.length) return `data-lines 一共 ${nums.length} 行，片段里有 ${i} 行（不算只有省略号的行）`;
  // 用 <code>：主题给 pre code 设的字号、行高对行号栏一样生效，两边的行才对得齐
  const gutter = el('code', 'lh-ln', marks.join('\n'));
  gutter.setAttribute('aria-hidden', 'true');
  if (label) label.after(gutter); else pre.prepend(gutter);
  pre.classList.add('lh-numbered');
  return null;
}

// root 里所有带出处的代码块；返回 [[pre, 出错说明], …]
export function numberAll(root) {
  const errs = [];
  for (const pre of root.querySelectorAll(CODE_BLOCKS)) {
    const e = numberLines(pre);
    if (e) errs.push([pre, e]);
  }
  return errs;
}
