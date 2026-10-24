// lh-log.js — 学习行为上报到本地服务器（learner/events.jsonl）
// 页面路径里已经包含 topic/周/天，所以每个事件只需带上 page。

// QA 模式（tools/qa.mjs 设置的标记，或无头浏览器）：不上报，避免自动化测试混进学习记录
export const QA_MODE = (() => {
  try { if (localStorage.getItem('lh:qa') === '1') return true; } catch { /* 忽略 */ }
  return /HeadlessChrome/.test(navigator.userAgent);
})();

export function log(type, data = {}) {
  if (QA_MODE) return;
  const body = JSON.stringify({ type, page: location.pathname, ...data });
  try {
    if (navigator.sendBeacon?.('/api/event', new Blob([body], { type: 'text/plain' }))) return;
  } catch { /* 回退到 fetch */ }
  fetch('/api/event', { method: 'POST', body, keepalive: true }).catch(() => {});
}
