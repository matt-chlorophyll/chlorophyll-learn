# 视觉主题

Chlorophyll-Learn 的课程页、交互组件、配音动画共用一套运行时（`/assets/lesson.js`、`component.js`、`player.js`），外观由**主题**决定。每个主题是这里的一个文件夹，自带样式、装饰脚本和 design system 文档。课件 HTML（writer 的产出）和主题无关：同一节课换个主题就换了一身衣服。

## 现有主题

| 主题 | 适合的学科 | 气质 | 样例页 |
|---|---|---|---|
| `quest` 今日委托 | 工程、编程、工具类 | 现代二次元游戏 UI：委托目标、本课图鉴、挑战、委托完成；天青配暖金，正文安静 | `/lab/themes/quest/` |
| `ink` 水墨 | 文科：历史、文学、哲学、艺术、语言 | 宣纸、墨分五色、竖排书法题头、朱砂印；内容和形式的反差 | `/lab/themes/ink/` |
| `anatomy` 图谱 | 数学、金融、物理、理论类 | 安静的技术图谱，力气花在等轴测"机器"图上；近白底、墨色、斜体衬线编号 | `/lab/themes/anatomy/` |

拿不准时按"这门课最核心的动作是什么"来选：动手做东西 → quest；读和理解人文内容 → ink；推导、建模、看清机制 → anatomy。

## 怎么指定主题

按这个顺序决定（`/assets/lh-theme.js`）：

1. URL 参数 `?theme=<名字>`：预览、对比。课程页会把它传给页内的组件和动画。
2. 页面 `<head>` 里的 `<meta name="lh-theme" content="<名字>">`：lab 里的样例页用。
3. `site/manifest.json` 里这门课的 `topics.<topic>.theme`：**正式课程用这个**，由 `/new-topic` 写入。
4. 默认主题 `quest`。

## 一个主题包含什么

```
themes/<名字>/
  lesson.css      课程页的完整样式（不是在别的主题上叠加）
  component.css   交互组件的样式和 token（见下文"token 契约"）
  player.css      配音动画播放器和舞台
  theme.js        选项（编号写法、文案）+ 装饰（setup）
  DESIGN.md       design system：概念、token、各元素的处理、viz/media 的画法规则、Do/Don't
  ……              主题自带的字体声明、SVG 纹理、绘图工具（如 anatomy 的 iso.js）
```

运行时先加载引导样式（`/assets/lesson.css` 等，只负责在主题样式到位前隐藏页面），再按主题加载上面三个 CSS。组件和动画自己的脚本在主题样式加载完之后才运行。

## 运行时生成的结构（所有主题一样）

主题只改外观：可以隐藏、重排（CSS `order`、grid）、加伪元素，不能依赖改动下面的结构。

**课程页**（`lesson.js`）

- `html[data-theme]`；QA 截图时 `html.lh-still`（一次性动效直接画到终点）
- 顶部条 `.lh-top`：`a.lh-back`、`.lh-title`（课程标题）、`.lh-track`（正在读：`b.no` "3/8" + `span.t` 段落标题）、`.lh-mini > span`（按分钟等比例的小条，状态同下）、`.lh-clock`（超时加 `.over`）
- **侧边今日路线** `nav.lh-toc`（`main` 的第一个子元素，要一直可见）：`p.lh-toc-h > span.lbl + span.lh-toc-count`（"3/8"），`.lh-toc-body > ol > li > a > span.no + span.t + span.m`，加上当前段标记 `.lh-toc-mark`。标记的位置写在 `.lh-toc-body` 的 CSS 变量 `--mark-y`、`--mark-h` 上（相对 `.lh-toc-body` 顶部）
- 页头路线概览 `nav.lh-route`（在 `.lesson-head` 末尾）：`ol > li[style=flex:分钟] > a > span.seg + span.t + span.m`，`p.lh-route-total`。可以隐藏或换成主题自己的装饰
- 状态类：`li.seen`（读过）、`li.now`（正在读），用在 `.lh-toc`、`.lh-route`、`.lh-mini` 上；段落本身 `section.is-done` / `section.is-now`；`li.stretch` 和 `section[data-stretch]` 是 Stretch 段
- 段落标题 `h2 > span.n[data-n] + span.ttl + span.rule + span.min`（编号的文字由 `options.number` 决定）
- 页边：`aside.stretch-tag > span.tag > span.emo`（🧗）+ `p`；`aside.later > span.tag > span.emo`（🔭）；普通 `aside`
- 正文元素：`mark`、`dfn`（术语，运行时收集成 `api.codex`）、`p.takeaway`、`pre > code` + `button.lh-copy`、`table`
- 配音动画 `figure.lh-slot.lh-media.wide > .screen > iframe` + `figcaption > span.kind + span.ttl + span.dur`
- 交互组件 `figure.lh-slot.lh-viz[.wide] > iframe` + `figcaption > span.kind + span.ttl + span.hint`
- 小测 `lh-quiz`（作答后 `.is-answered`，选择题再加 `.is-right` / `.is-wrong`，回想题看过答案 `.is-open`）：`.lh-qlabel`、`.q`、`ul.opts > li > button[.right/.wrong/.dim] > span.k + span`、`p.verdict.ok/.no`、`.why`；回想题另有 `textarea`、`.reveal-row > button.reveal`、`.self > button[.picked]`。点击位置在 `--hit-x`、`--hit-y`
- 打卡 `lh-checkin`（已打卡 `.is-done`）`> .lh-stub`：
  - 表单：`h2`、`p.sub`、`form > .lh-field`（`label`、`span.hint`、`input`、`textarea`）、`fieldset.lh-field > legend`、`.lh-scale > label > input[type=radio] + span.key + span.dt`、`.lh-chips > label > input[type=checkbox]`、`button.lh-btn`、`p.lh-err`
  - 结算：`.lh-done > .lh-reward[.celebrate] > .lh-emblem`（空，给主题放徽记）`+ .lh-rtext > h2.rt + p.rs`；`dl.lh-stats > div > dt + dd > small`；`p.lh-done-msg`；`p.lh-done-edit > button.lh-btn.ghost`
- 捕获按钮 `.lh-capture > button[data-kind=ask|confused|sleepy|pause]`（`ask` 是「问老师」，排第一个，做成主按钮，有未读回答时里面多一个角标 `span.lh-badge`（"3"，超过 9 条写"9+"）；`confused` 是「这里没懂」；`sleepy` 是「犯困了」、`pause` 是「暂停」，排最后两个，和前面的稍微分开；选中文字时另有 `.lh-capture.floating`，里面只有 `ask` 和 `confused`，没有角标），弹窗 `.lh-pop`，提示 `.lh-toast.show`，横幅 `.lh-banner`，缺失组件 `.lh-missing`
- 问老师面板 `aside.lh-ask[hidden]`（`lh-ask.js`；打开时 `html.lh-asking`）：
  - `.lh-ask-h > h4 + p.lh-ask-ctx`（"关于第 3 段「……」"）`+ button.lh-ask-x`
  - `.lh-ask-log`：空状态 `p.lh-ask-empty`；每轮 `.lh-ask-turn > .lh-ask-q`（`blockquote` 选中的文字 + `p` 问题）`+ .lh-ask-a`（回答渲染成 `p`、`ul`/`ol`、`pre > code`、`code`、`strong`；等第一个字时 `.is-pending` 且为空；出错或回答没收到 `.is-error > p.err + p.lh-ask-retry > button.lh-btn.ghost`（"重问"）；最新一条是做题提示时 `p.lh-ask-hint > span + button.lh-btn.ghost`（"我试过了，看答案"）；答完的每一条末尾是归类 `p.lh-ask-cat[data-cat=now|dig|weekend] > b + 文字`（"当场讲完"、"已存进想深挖：<标签>，……"、"已存进周末问：……"））
  - `form.lh-ask-f > .lh-ask-quote[hidden] > span + button` + `textarea` + `.row > span.hint + button.lh-btn.ghost`（清空）`+ button.lh-btn.ghost.later`（"发送，稍后看"；当场回答中文字变"稍后看"）`+ button.lh-btn`（当场回答中加 `.stop`，文字变"停止"）
  - 面板固定在页面右侧、捕获按钮上方；窄屏（≤760px）改成底部的大面板
- 犯困了的提示框 `.lh-sleepy[hidden] > h4 + p.why + ol > li > b + 文字`（三件事）`+ .row > button.lh-btn.ghost`（"好，继续学"）`+ button.lh-btn`（"暂停，起来活动 2 分钟"）。放在捕获按钮上方（和 `.lh-pop` 同一位置），层级高于问老师面板和弹窗、低于提示和暂停层；可以和问老师面板同时开着
- 回指回看（`lh-recall.js`，样式在 `/assets/lh-recall.css`，只用 token；主题想改外观就在自己的 `lesson.css` 里覆盖）：正文里的 `lh-recall[role=button][aria-expanded]`（打开时 `.is-open`；`::before` 是扩大点击区的透明块，`::after` 是「回看」小标记）；小窗 `.lh-recall-pop.kind-<quiz|text|note|media|viz>`（`position: absolute` 跟着页面滚动，层级 36：高于问老师面板和犯困了提示框，低于提示和暂停层）`> .lh-recall-h > p > span.kind + span.where` `+ button.lh-recall-x`，`.lh-recall-body`（题目：`.lh-recall-stem`、`ul.lh-recall-opts > li[.right/.was] > span.k + span.t + span.tag`、`p.lh-recall-hint`、`.lh-recall-revealrow > button.lh-btn.ghost.lh-recall-reveal`、`.lh-recall-result > p.lh-recall-was + .lh-recall-why`；讲解：`.lh-recall-copy`（表格包在 `.lh-recall-scroll` 里）；留言：`p.lh-recall-meta + .lh-recall-copy.lh-recall-quote > blockquote`；动画和组件：`p.lh-recall-note`），`.lh-recall-f > a.lh-recall-go`（「去原文」）。从「去原文」打开的旧课里，落点短暂加 `.lh-recall-target`，顶部有一条 `.lh-banner`（只读说明）
- 暂停层 `.lh-pause[hidden]`（暂停时 `html.lh-paused`，主题要在这时禁止页面滚动）`> .lh-pause-card > h2`（"学习已暂停"）`+ p.lh-pause-sub`（"已学 N 分钟……"）`+ button.lh-btn`（"继续学习"）。盖住整页、虚化后面的内容（`backdrop-filter`），层级要高于问老师面板和提示；后面的元素在暂停时都是 `inert`

**配音动画**（`player.js`）：`.lh-player`（`.playing` `.at-start` `.at-end` `.idle` `.cc-off`）`> .lh-frame > #stage`、`.lh-cc > span`（第二个声音 `span.b`）、`button.lh-big[data-state=start|end] > span.ico + span.t`、`.lh-controls > .lh-play + .lh-time + .lh-bar > .lh-fill + .lh-speed + .lh-ccbtn(.on) + a.lh-dl`（导出过 mp4 才有）`+ .lh-fs`。舞台 1280×720，底部 15% 留给字幕和控制条。

**交互组件**（`component.js`）：组件 HTML 由 viz agent 自由写；滑块的已填充比例写在 `input[type=range]` 的 `--fill` 上。

## token 契约

每个主题的 `component.css` 和 `player.css` 都要在 `:root` 定义下面这些变量（组件和场景的作者只用它们表达颜色和字体，换主题时自动跟着变）。`lesson.css` 至少定义 `--red`。

| 变量 | 含义 |
|---|---|
| `--paper` `--paper-2` | 底色、次一级底色（代码块、输入框） |
| `--ink` `--pencil` `--rule` | 正文、次要文字、线 |
| `--marker` | 重点、当前 |
| `--pen` | 链接、🔭、"可以点" |
| `--climb` | 答对、🧗、成功 |
| `--red` | 答错、静默出错、缺失 |
| `--screen` | 配音动画舞台底色 |
| `--sans` `--mono` | 字体 |

主题可以另加自己的 token（如 `--gold`、`--ink-nong`），写进 DESIGN.md。

## theme.js

```js
export const options = {
  number: n => String(n).padStart(2, '0'),  // 段落编号的写法（目录和标题共用）
  labels: {                                 // 只写要改的；默认值见 lesson.js 的 DEFAULTS
    toc: '今日路线', back: '← 本周', later: '后面会讲', stretch: 'Stretch',
    media: '配音动画', viz: '交互', quiz: (n, total) => `小测 ${n}/${total}`, reveal: '回想题',
    done: '已打卡', statRoute: '路线', statTerms: '术语', checkinSub: '……',
  },
};

export function setup(api) {
  // api.theme / main / head（.lesson-head）/ top / toc / route / sections（{ el, id, title, min, stretch, index }）
  // api.codex（{ text, sec, el, got }）/ est / h(tag, props, ...kids) / store / qa（QA 模式）/ current / seen / finished()
  // api.on('progress', ({ current, seen, finished, done, total }) => …)   当前段或读过的段变了（订阅时立刻收到一次当前状态）
  // api.on('quiz', ({ id, q, kind, right, self, fresh }) => …)            作答；fresh = 这次是学习者刚点的
  // api.on('checkin', ({ fresh, box, reward, emblem }) => …)              打卡结算渲染；fresh = 刚提交（只在这时放庆祝动效）
}
```

规则：
- 装饰只加 `aria-hidden="true"` 的元素，不改文字内容，不删运行时生成的元素（可以用 CSS 隐藏）。
- 一次性动效在 `html.lh-still` 和 `prefers-reduced-motion: reduce` 时直接到终点。
- 只能 import 自己文件夹里的模块（如 `./iso.js`），不 import 运行时的内部实现。
- 出错不会让页面挂掉（运行时会接住并记进 QA 报告），但 QA 会报错，所以要处理干净。

## 样例页和验收

`/lab/themes/<名字>/` 是 Day 0 的拷贝，用 `<meta name="lh-theme">` 指定主题，里面的交互组件和配音动画按这个主题的画法重画过，是 viz/media agent 的参考实现。改主题后跑：

```
node tools/qa.mjs lab/themes/<名字>
```

0 错误 0 警告，再看 `.tmp/qa/lab/themes/<名字>/` 的截图（`page-top.png` 是首屏）。

## 加一个新主题

1. 复制一个现有主题文件夹改名，改三份 CSS、`theme.js`、`DESIGN.md`。
2. 把名字加进 `/assets/lh-theme.js` 的 `THEMES`。
3. 复制一个 `/lab/themes/<名字>/` 样例页，改 meta，按新画法重画组件和动画。
4. 在上面的"现有主题"表里写清适合的学科。
