---
name: build-week
description: 生成一周的课件：planner 规划 → writer/viz/media 并行实现 → reviewer 审核 → 修复（最多 2 轮）→ 开放到 hub → commit。周末运行，完整档约 3–4 小时；加 lite 是轻量档。
argument-hint: "[周序号，默认下一周；0 = Day 0 导览课] [lite]"
disable-model-invocation: true
---

# /build-week $ARGUMENTS

你是总统筹。按下面的流程调度 subagent 生成一周课件。**你自己不读 spec、review 和路线图，也不写课程内容**（防剧透，见 CLAUDE.md）。

## 0. 准备

1. 参数里有 `lite` 就用**轻量档**（见文末「轻量档」），下面每一步按它的说明收缩。
2. 从 `learner/state.md` 取主题 slug（下文记作 `<topic>`）和视觉主题（`site/manifest.json` 的 `topics.<topic>.theme`；新主题还没进 manifest 时看 `state.md` 的「视觉主题」，下文记作 `<theme>`）。新主题还没进 manifest 的，现在就在 manifest 的 `topics` 里建 `"<topic>": { "title": "主题名", "theme": "<theme>", "weeks": [] }`，不改 `current`（hub 上看不出变化）：这样课程页、组件和 QA 截图从一开始就用这门课的主题。周序号 N：用参数；没有参数就用当前周 + 1。`NN` 是两位数（`w00`、`w01`）。
3. 运行 `node tools/now.mjs`，记下开始时间（学习者时区的日期、星期和时间；不用 `date` 命令，那是电脑的时区）。结束时再运行一次，用时写进生成记录。
4. 确保本地服务器在运行：`node tools/serve.mjs --detach`（已经在运行会直接说；没有就在后台启动，输出地址）。它是独立进程，整个流程期间一直运行。不要用 Bash 的 `run_in_background` 启动服务器（后台任务有时长上限，会被停掉），也不用 curl 检查。
5. 告诉学习者：开始生成第 N 周，大约需要多久（完整档 3–4 小时，轻量档约一半），期间窗口要保持打开；可以随时在这里提问。

## 1. 规划

派 `planner`：

> 任务 B：规划第 N 周。主题 `<topic>`。今天（学习者时区）：<now.mjs 输出的日期和星期>。（轻量档时加上：「轻量档：每天最多 1 个 viz、1 个 media，能用文字讲清的不做组件。」）（如有）上周复盘摘要：`learner/digests/<文件>`。（如有）`learner/state.md` 未结事项里待转给 planner 的内容，例如诊断题作答：<原样贴上>。完成后按约定返回。

N = 0 时改为：「任务 B：规划 Week 0，只有一节 Day 0 导览课（≤30 分钟），内容见 /new-topic 的要求。今天（学习者时区）：<日期和星期>」。

然后读 `curriculum/<topic>/wNN/build.json`（只有本周的标题、组件 id、概念，可以读）。

## 2. 实现 + 审核（按天流水线，同时做 2 天）

对每一天 dN，在**同一条消息里**并行派出它需要的 builder（`builders` 里没有的就不派）：

| agent | 提示 |
|---|---|
| `writer` | spec：`curriculum/<topic>/wNN/dN.spec.md`。输出：`site/lessons/<topic>/wNN/dN/index.html`。 |
| `viz` | spec：同上。你负责的组件 id：`a, b`。输出目录：`site/lessons/<topic>/wNN/dN/viz/`。视觉主题：`<theme>`。 |
| `media` | spec：同上。你负责的配音动画 id：`x`。输出目录：`site/lessons/<topic>/wNN/dN/media/`。视觉主题：`<theme>`。 |

每个提示末尾加一句：「按你的 agent 说明工作，完成后按约定格式返回。」两天同时进行，最多 6 个 agent 并行。记下每个 agent 的 id，修复轮要用。

某一天的 builder 全部返回后，立刻派 `reviewer`（不用等另一天）：

> spec：`curriculum/<topic>/wNN/dN.spec.md`。课程目录：`site/lessons/<topic>/wNN/dN/`。视觉主题：`<theme>`。写 `curriculum/<topic>/wNN/dN.review.md`（第 1 轮）。

## 3. 修复循环（每天最多 2 轮）

- reviewer 返回的计数里有**阻塞或应修**：用 SendMessage 把对应 builder 叫回来（agent 已不可用就新派一个同类型的，附上 spec 路径）：
  > 修复轮：读 `curriculum/<topic>/wNN/dN.review.md` 里归你的阻塞和应修条目，逐条修复，自测后返回。
- 修完后让 reviewer 复查：「复查（第 2 轮）：只看上一轮的阻塞和应修条目。」
- 只剩小问题就算通过。
- 第 2 轮后仍有阻塞：派 `writer`「读 dN.review.md 里仍存在的阻塞条目，把对应的插槽或段落从 index.html 删掉，调整 data-min，让页面能独立成立」，然后跑一次 `node tools/qa.mjs lessons/<topic>/wNN/dN` 确认没有错误。在生成记录里写明砍掉了什么（按组件 id 写，不写内容）。

## 4. 开放和收尾

1. **开放到 hub**（编辑 `site/manifest.json` 和 `site/map.json`，两个文件同时改）：
   - 在 manifest 的 `topics.<topic>.weeks` 里加入本周：`{ "week": N, "title": build.json 的 title, "lessons": [{ "day", "date", "title", "est", "path": "/lessons/<topic>/wNN/dN/" }] }`。
   - 主题第一次出现时先建 `topics.<topic> = { "title": "主题名", "theme": "<theme>", "weeks": [] }`。
   - 把 `current` 设为 `{ "topic": "<topic>", "week": N }`。
   - 把 manifest 顶层的 `timezone` 设为 `node tools/now.mjs --json` 输出的 `timezone`（hub 用它判断哪节课是今天）。
   - 迷雾地图：在 `site/map.json` 的 `topics.<topic>.weeks` 里加入（已有同一周就替换）`{ "week": N, "days": [{ "day", "map": build.json 那天的 map }] }`。主题第一次出现时先建 `topics.<topic> = { "regions": build.json 的 regions, "weeks": [] }`；build.json 带了新区域（只会加在末尾）就追加到 `regions` 末尾，已有区域的顺序和 `lanes` 不动。
   - 合完检查 map.json：`id` 不重复，每个 `links` 指向的 id 都已经在 map.json 里，每个 `region` 都在 `regions` 里。有问题让 planner 改 build.json，不要自己编连线。
   - **例外**：上一周的课还没学完（看 `state.md` 的本周进度），而且今天还在上一周里，就先不改 manifest 和 map.json，在 `state.md` 记「第 N 周已生成，等上一周学完或新的一周开始时开放」；之后由 `/today` 开放，两个文件一起改。Week 0 和第 1 周直接开放。
2. 更新 `learner/state.md`：当前周、「本周概念」（合并 build.json 各天的 `concepts`）、下一步。
3. 在 `platform/build-log.md` 追加一行：日期、主题/周、课数、用时、修复轮次、被砍掉的部分、备注（例如有没有弹权限确认、哪个 agent 最慢）。
4. 工作区是 git 仓库时：`git add -A`，然后 `git commit -m "build: <topic> wNN（N 节课）"`；有远端再 `git push`（见 CLAUDE.md「git」）。不是 git 仓库就跳过。
5. **导出 mp4**（后台，不阻塞；轻量档跳过。没装 ffmpeg 时 render-video.mjs 会自己说明并跳过，不用先检查）：用 Bash 的 `run_in_background`（`timeout` 设成最大的 7200000：默认约 10 分钟就会被停）对每节课跑 `node tools/render-video.mjs site/lessons/<topic>/wNN/dN`，每个动画目录下生成 `video.mp4`（不进 git，可重新生成；约为动画时长的 1.7 倍）。
6. 告诉学习者：本周课程已就绪（列出每天的标题和预计分钟），从 hub 或 `/today` 开始。

## 注意

- 派出的 subagent 完成时你会收到通知，等通知就行：不要用 `sleep` 轮询，也不要反复查输出文件（白名单以外的命令都要学习者点确认）。
- 生成过程中学习者可能来问问题：照常回答（遵守深挖拦截），subagent 在后台继续跑。
- 如果 `planner`、`writer` 等 agent 类型不可用（新加的 agent 要重启 Claude Code 才生效），用 `general-purpose` 代替，提示开头加：「先读 `.claude/agents/<名字>.md`，严格按它的说明工作。」
- 额度紧张时用轻量档；还不够，在对应 agent 文件的 frontmatter 把 `model` 改成 `sonnet`（writer 优先降级）。
- 生成一周会调用很多次 subagent。额度少的方案（例如 Pro）可能一次跑不完完整档：先用轻量档试一周，看 `/usage` 的消耗再决定。

## 轻量档（`lite`）

更快、更省额度，代价是组件少一些、审核粗一些。
- 规划：每天最多 1 个 viz、1 个 media（写进给 planner 的任务 B）。
- 实现：派 writer、viz、media 时在 Agent 调用里指定 `model: "sonnet"`；planner 和 reviewer 保持默认。
- 审核：给 reviewer 的提示末尾加「轻量档：截图只看 page-top、page、每个组件和每个动画的封面，beat 截图抽查 3 张；事实核查只查有时效性的说法。」
- 修复：每天最多 1 轮，之后还有阻塞就按第 3 步的办法砍掉对应部分。
- 收尾：不导出 mp4。
