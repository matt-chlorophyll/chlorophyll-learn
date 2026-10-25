---
name: setup
description: 建立或更新 Chlorophyll-Learn 学习工作区：第一次运行时在你选的文件夹里生成课程网站、工具、老师规则和 subagent；以后再运行只更新平台文件，不碰学习记录和课程。
argument-hint: "[工作区文件夹，可省略]"
disable-model-invocation: true
---

# /chlorophyll-learn:setup $ARGUMENTS

你在帮用户安装或更新 Chlorophyll-Learn：一个由 Claude Code 驱动的个人学习平台。安装脚本是 `${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs`，模板在 `${CLAUDE_PLUGIN_ROOT}/template/`。用简体中文和用户交流。

## 1. 确定工作区文件夹

- 参数里给了文件夹：就用它。
- 当前目录里有 `.chlorophyll/install.json`：这是已有的工作区，进入**更新**。
- 否则用 AskUserQuestion 问一次（一个问题）：工作区放在哪里。选项：`~/chlorophyll-learn`（推荐，新建）、当前目录（只在当前目录是空的时候列出）。用户可以在「其他」里写自己的路径。

工作区就是以后学习的地方：每次学习都在这个文件夹里打开 Claude Code。

## 2. 运行安装脚本

先检查 Node 版本：`node --version`。低于 22 就停下，告诉用户先装新版 Node.js（https://nodejs.org ，选 LTS），装好再运行本命令。

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" "<工作区文件夹>"
```

- 脚本拒绝（目录不是空的，也不是工作区）：告诉用户原因，问是换一个空文件夹，还是确认覆盖（加 `--force` 重跑）。不要自己加 `--force`。
- 最后一行是 JSON 摘要：`mode`（install / update）、`backedUp`（被备份的、用户改过的平台文件）、`env`（环境检查）。

## 3. 第一次安装后

1. 环境里有 ✗ 的，按下面给出一句话的解决办法（可选的项说明"不装也能用"）：
   - Claude Code 找不到：「问老师」要用命令行里的 `claude`，确认 `claude --version` 能运行。
   - 浏览器：装 Chrome，或者在工作区 `.env` 里用 `CHROME_BIN` 指定 Chrome / Edge 的路径。
   - ffmpeg（可选）：Windows `winget install Gyan.FFmpeg`，macOS `brew install ffmpeg`，Linux 用包管理器。没有它，配音动画是无配音的字幕版，也不能导出 mp4。
   - 配音 key（可选）：在工作区的 `.env` 里填 `MINIMAX_API_KEY`（中文推荐，https://www.minimax.io ）或 `ELEVENLABS_API_KEY`。没有 key 也能上课，配音动画只显示字幕。提醒用户不要把 key 贴到对话里，自己打开 `.env` 填。
2. git（可选）：工作区还不是 git 仓库、电脑上有 git 时，问一句要不要初始化（推荐：能回看每周生成了什么，出问题可以回退）。要的话在工作区里运行 `git init`，再 `git add -A` 和 `git commit -m "init: Chlorophyll-Learn <版本>"`。提醒：以后推到远端，仓库一定要设成私有，里面有学习档案和隐藏路线图。
3. 告诉用户下一步（照这个顺序，简短）：
   - 在工作区里重新打开 Claude Code：`cd "<工作区文件夹>"`，然后 `claude`。老师规则、命令和 subagent 都在工作区里，要在那里打开才会生效。
   - 运行 `/new-topic <想学的主题>`：老师先问几个问题，然后准备 Day 0 导览课或第一周。
   - 打开课程网站：Windows 双击工作区里的 `start.cmd`，macOS / Linux 运行 `./start.sh`。想先看看一节课是什么样，打开 http://localhost:4321/lab/example/ （示例课：古诗词鉴赏 Day 0，不计入学习记录）。
   - 节奏：工作日每天 `/today` 上一节课（以看为主），周末练习，然后 `/build-week` 生成下一周（完整档约 3–4 小时，窗口要开着；`/build-week N lite` 是更快、更省额度的轻量档）。
   - 额度：生成一周会调用很多次 subagent，额度少的方案建议先用轻量档，看看 `/usage`。

## 4. 更新之后

- 说明从哪个版本更新到哪个版本，更新了几个平台文件；学习记录、课程、manifest 和用户自己的设置（`platform/tts.json`、`platform/pronunciation.md`）没动。
- `.claude/settings.json` 只补新版本加的权限设置：`settingsAdded` 不为空就列出补了哪几条；为 `null` 表示文件不是合法的 JSON、没有补，请用户检查这个文件。
- `keptLocal`：用户改过、这次新版本没改的平台文件，保留了用户的版本，提一句就行。
- `backedUp` 不为空：这些文件用户改过、新版本也改了，已换成新版本，用户的版本备份在 `backupDir` 里。列出这些文件。其中有 `platform/style-guide.md` 或 `CLAUDE.md` 的，问用户要不要把自己加过的内容合并回新版本：要的话对比备份和新文件，只把用户自己加的段落（例如风格指南「经验」里的新条目）补进新文件，别的不动。
- 提醒：如果 Claude Code 正开在工作区里，重新打开一次，新的命令和 subagent 才会生效。

## 注意

- 不读、不改工作区里的 `curriculum/`（隐藏路线图和课程规格，学习者看到会被剧透）和 `learner/`。
- 只运行上面列出的命令。
