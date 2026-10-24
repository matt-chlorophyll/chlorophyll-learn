// theme.js — 主题「墨」的选项和装饰（接口见 /assets/themes/README.md）
//
// - 段落编号用汉字（一、二、三……），目录和段落标题共用；书法字体淡墨显示
// - 题头：一滴墨（写意，晕开一次）+ 一方朱砂「日课」印
// - 打卡结算：在 .lh-emblem 里盖「日课」印；刚提交时（fresh）CSS 放盖印动效（.lh-reward.celebrate）
// 装饰元素都是 aria-hidden，不改任何文字内容。

const CN = '〇一二三四五六七八九';
const cn = n => (n < 10 ? CN[n]
  : n < 20 ? '十' + (n % 10 ? CN[n % 10] : '')
  : CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : ''));

export const options = {
  number: cn,
  labels: {
    done: '日课已毕',
  },
};

export function setup(api) {
  const { h, head } = api;
  const seal = cls => h('span', { class: `lh-seal${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, '日课');

  if (head) head.append(h('div', { class: 'lh-ink', 'aria-hidden': 'true' }), seal());

  api.on('checkin', ({ emblem }) => {
    if (emblem && !emblem.querySelector('.lh-seal')) emblem.append(seal());
  });
}
