# Chlorophyll-Learn 开发说明

给在这个仓库里开发插件的人和 Claude Code 看。插件用户不会加载这个文件：插件根目录的 CLAUDE.md 不生效，学习工作区里的老师规则是 `template/CLAUDE.md`。

用简体中文写 issue、PR、提交信息和文档，技术术语保留原文。

## 仓库结构

- `.claude-plugin/`：`plugin.json` 和 `marketplace.json`。仓库本身就是 marketplace `chlorophyll`，插件名 `chlorophyll-learn`。
- `skills/setup/SKILL.md` + `scripts/setup.mjs`：唯一的插件命令 `/chlorophyll-learn:setup`。第一次运行把 `template/` 装成学习工作区，以后再运行只更新平台文件。
- `template/`：学习工作区模板，包括老师规则、`/today` 等命令、5 个 subagent、课程网站和工具。改这里，就是改用户拿到的平台。
- `docs/screenshots/`：README 的截图，来自 `template/site/lab/example/` 的示例课。

## 规矩

- **公开仓库**：issue、PR、提交和示例里不写任何个人信息，包括真实的学习记录、时区、本机路径和 key。示例用虚构的学习者。
- **走 PR**：issue → 分支 → PR（只开 squash 合并），正文写 `Closes #N`。维护者验收：看描述和截图，自己装一遍。
- **版本**：用户能感知的改动发布前，改 `.claude-plugin/plugin.json` 的 `version`。插件按版本缓存，版本不变，用户 `claude plugin update` 拿不到新内容。setup 也用这个版本号告诉用户"从哪个版本更新到哪个版本"。
- **设计约束**：
  - 不依赖其他 skill，例如 gstack。
  - 工具只用 Node.js ≥ 22 的内置模块，不加 npm 依赖。
  - 没有 TTS key、没有 ffmpeg 也要能跑：配音动画降级成字幕版。
  - 浏览器用本机的 Chrome 或 Edge（`template/tools/lib/chrome.mjs`，DevTools 协议）。
- **目前只做中文**。

## 改 template/ 时注意更新逻辑

- **种子文件**：`learner/`、`curriculum/`、`site/manifest.json`、`site/map.json`、`platform/pronunciation.md`、`platform/tts.json`、`platform/build-log.md`、`.claude/settings.json`、`gitignore`。setup 只在工作区里没有时创建，之后归学习者所有，更新时不覆盖。所以改它们的默认值只影响新安装。例如在 manifest 里加一个 lab 页面，老用户的首页上看不到。
  - 例外是 `.claude/settings.json`：更新时补上模板新加的 `permissions.allow` 条目和 `defaultMode`（`scripts/setup.mjs` 的 `mergeSettings`）。`.chlorophyll/install.json` 记着上次装进来的模板设置，学习者自己删掉的条目不会加回来。
- **权限白名单**（`template/.claude/settings.json`）：
  - 规则不要以 `:*` 结尾，会被当成旧的前缀语法：`Bash(curl -s http://127.0.0.1:*)` 匹配不上 `…:4321/…`，要写成 `:*/*`。
  - 命令前带环境变量的（`PORT=… node tools/…`）匹配不上任何规则，所以 agent 说明里要求不加。
  - 改完按下面「怎么测」里的办法数一遍要确认的命令。
- **其他平台文件**：setup 三方比较，依据是安装时记下的哈希。
  - 用户没改过：直接更新。
  - 用户改过、模板这次没改：保留用户的版本。
  - 两边都改了：用户的版本先备份到 `.chlorophyll/backup/`，再换成新版。
  - 删除或改名文件之前，想清楚对老用户的影响。
- **`template/gitignore`**：复制时改名为 `.gitignore`。

## 怎么测

- **setup**：`node scripts/setup.mjs <临时目录>` 装一次，再跑一次测更新。`--check` 只检查环境。
- **课程页**：
  - 先把测试工作区 `.env` 里的 `PORT` 改成 43xx，不要占 4321。
  - 起服务器：`node tools/serve.mjs --detach`。它是独立的后台进程，不随命令结束，测完用 `node tools/serve.mjs --stop` 停掉。跑 QA 时没开它也行，`qa.mjs` 会自己这样启动。
  - 跑 QA：`node tools/qa.mjs <页面路径>`。一次只开一个无头浏览器。
- **插件**：
  - 先跑 `claude plugin validate .`。
  - 安装测试用临时配置，不碰自己的：`CLAUDE_CONFIG_DIR=<临时目录> claude plugin marketplace add <本仓库路径>`，再运行 `claude plugin install chlorophyll-learn@chlorophyll`。
  - Windows 上临时目录的路径要短，否则 git clone 会报"Filename too long"。
  - 测升级：同一个临时配置里先从 main 装，建好工作区；再把插件源切到新分支，`claude plugin marketplace update chlorophyll`、`claude plugin update chlorophyll-learn@chlorophyll`，用新缓存里的 `scripts/setup.mjs` 重跑。
- **权限（生成课程时要确认几次）**：在测试工作区里跑
  `claude -p "/new-topic <主题>（访谈答案）" --setting-sources project --settings .claude/settings.json --permission-prompts none --output-format stream-json --verbose > run.jsonl`，
  再数 `"subtype":"permission_denied"`，每一条就是交互时的一次确认。
  - 没被信任过的工作区会忽略项目白名单，所以要用 `--settings` 再传一次；`--setting-sources project` 是为了不带上自己的用户设置（比如 auto 模式）。
  - 生成一节 Day 0 约 25 分钟，按 API 价格约 $12，走自己的订阅额度。
  - 跑完测试工作区的服务器还开着，用 `node tools/serve.mjs --stop` 停掉。
- **改了课程页或组件**：用示例课 `/lab/example/` 和 `/lab/themes/` 跑 QA。
