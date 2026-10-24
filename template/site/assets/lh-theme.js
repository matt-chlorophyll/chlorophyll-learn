// lh-theme.js — 视觉主题：决定当前页面用哪个主题，并加载它的样式
//
// 每个主题是 /assets/themes/<名字>/ 下的一个文件夹（说明见 themes/README.md）：
//   lesson.css（课程页）、component.css（交互组件）、player.css（配音动画）、theme.js（选项和装饰）、DESIGN.md
// 用哪个主题，按这个顺序决定：
//   1. URL 参数 ?theme=<名字>（预览、对比；课程页会把它传给页内的组件和动画）
//   2. 页面里的 <meta name="lh-theme" content="<名字>">（lab 里的主题样例页用）
//   3. manifest.json 里这门课的 topics.<topic>.theme（按 /lessons/<topic>/ 路径）
//   4. 默认主题

export const THEMES = ['quest', 'ink', 'anatomy'];
export const DEFAULT_THEME = 'quest';

const valid = t => (THEMES.includes(t) ? t : null);

export async function resolveTheme() {
  const fromUrl = valid(new URLSearchParams(location.search).get('theme'));
  if (fromUrl) return fromUrl;
  const fromMeta = valid(document.querySelector('meta[name="lh-theme"]')?.content);
  if (fromMeta) return fromMeta;
  const topic = location.pathname.match(/^\/lessons\/([^/]+)\//)?.[1];
  if (topic) {
    try {
      const m = await (await fetch('/manifest.json', { cache: 'no-store' })).json();
      const t = valid(m.topics?.[topic]?.theme);
      if (t) return t;
    } catch { /* 拿不到 manifest 就用默认主题 */ }
  }
  return DEFAULT_THEME;
}

export const themeUrl = (theme, file) => `/assets/themes/${theme}/${file}`;

// 主题样式紧跟在同名的引导样式（/assets/lesson.css 等）后面插入，排在页面自己的 <style> 之前：
// 优先级相同时，组件和场景自己写的样式要能盖过主题的默认样式。
// 加载失败也照样继续：页面至少还能用
export function loadCss(href) {
  return new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = link.onerror = () => resolve();
    const name = href.split('/').pop();
    const boot = document.querySelector(`link[rel="stylesheet"][href$="/assets/${name}"]`);
    if (boot) boot.after(link);
    else document.head.prepend(link);
  });
}

// 引导样式在 html 没有 .lh-themed 时隐藏 body（避免闪一下没样式的页面），3 秒后无论如何显示
export function reveal(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.add('lh-themed');
}

// 组件和配音动画用：解析主题 → 加载对应样式 → 显示
export async function applyTheme(file) {
  const theme = await resolveTheme();
  await loadCss(themeUrl(theme, file));
  reveal(theme);
  return theme;
}
