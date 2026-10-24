// theme.js — 「今日委托」主题的选项和装饰（接口见 /assets/themes/README.md）
//
// - options：段落编号用阿拉伯数字；文案换成委托的说法（委托目标 / 挑战 / 委托完成 / 图鉴）
// - setup：
//   1. 委托卡（.lesson-head）上压「今日委托」标签；页头的路线概览前加小标题「时间分配」
//   2. 本课图鉴：把 api.codex（正文里的 <dfn> 术语）列在委托卡里，读到它所在的段落就收录（progress 事件）
//   3. 窄屏时侧边的委托目标排成两列：按条数算好行数（--rows）
//   4. 打卡结算：在 .lh-emblem 里画委托完成徽记；刚提交（fresh）时 CSS 的 .celebrate 动效会播放一次
// 所有加进去的元素都是 aria-hidden 的装饰，不改运行时生成的文字和结构。

export const options = {
  number: n => String(n),
  labels: {
    toc: '委托目标',
    quiz: (n, total) => `挑战 ${n}/${total}`,
    reveal: '回想挑战',
    done: '委托完成',
    statRoute: '目标',
    statTerms: '图鉴',
    checkinSub: '两分钟就好。提交之后，今天的委托就完成了；老师会根据这些调整明天的内容。',
  },
};

// 委托完成的徽记：双线菱形 + 对勾（对勾在庆祝动效里一笔画出）
const EMBLEM = `<svg viewBox="-50 -50 100 100">
  <defs><linearGradient id="lh-quest-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F6CD66"/><stop offset="1" stop-color="#D3932A"/></linearGradient></defs>
  <rect x="-33" y="-33" width="66" height="66" transform="rotate(45)" fill="none" stroke="#A9C6DD" stroke-width="1.5"/>
  <rect x="-27" y="-27" width="54" height="54" transform="rotate(45)" fill="url(#lh-quest-gold)"/>
  <rect x="-22" y="-22" width="44" height="44" transform="rotate(45)" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.2"/>
  <path class="chk" d="M-14 1 L-4 11 L15 -9" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function setup(api) {
  const { h, head, route, toc, codex } = api;

  // 1. 委托卡标签 + 时间分配小标题
  if (head) head.prepend(h('span', { class: 'lh-tab', 'aria-hidden': 'true' }, h('i', { class: 'dia' }), '今日委托'));
  route?.prepend(h('p', { class: 'lh-cardh', 'aria-hidden': 'true' }, '时间分配'));

  // 2. 本课图鉴
  let codexCount = null;
  if (codex.length && head) {
    codexCount = h('b', {}, `0/${codex.length}`);
    for (const c of codex) c.chip = h('li', {}, h('i', { class: 'dia' }), c.text);
    head.append(h('div', { class: 'lh-codex', 'aria-hidden': 'true' },
      h('p', { class: 'lh-cardh' }, '本课图鉴', codexCount),
      h('ul', {}, codex.map(c => c.chip)),
      h('p', { class: 'hint' }, '正文里带金色小菱形的术语，读到就收录。')));
  }

  // 3. 窄屏两列时，前一半在左列、后一半在右列
  toc?.style.setProperty('--rows', String(Math.ceil(api.sections.length / 2)));

  api.on('progress', () => {
    if (!codexCount) return;
    let got = 0;
    for (const c of codex) { c.chip.classList.toggle('got', c.got); if (c.got) got++; }
    codexCount.textContent = `${got}/${codex.length}`;
  });

  // 4. 委托完成徽记：八道细金线 + 六颗小菱形（只有 .celebrate 时才动起来，平时透明）
  api.on('checkin', ({ emblem }) => {
    if (!emblem || emblem.querySelector('svg')) return;
    emblem.innerHTML = EMBLEM;
    for (let i = 0; i < 8; i++) emblem.append(h('i', { class: 'ray', style: `--a:${i * 45 + 22.5}deg` }));
    for (let i = 0; i < 6; i++) emblem.append(h('i', { class: 'spark', style: `--a:${i * 60 + 8}deg;--d:${56 + (i % 3) * 12}px` }));
  });
}
