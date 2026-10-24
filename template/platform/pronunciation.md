# TTS 发音词表

配音稿里的英文术语，如果 TTS 读得不对，就在这里加一行。

- 只影响送给 TTS 的文本，**不影响字幕**（字幕仍显示左列的写法）。
- 只做整词匹配、区分大小写：`RAG` 不会误伤 `RAGE` 或 `rag`。
- 某一句需要特殊读法时，也可以在 script.json 的 beat 里写 `say` 字段，单独覆盖那一句。
- 改完后重新跑 `node tools/tts.mjs <目录>`，只有受影响的 beat 会重新合成。

| 写法 | 读法 | 备注 |
|---|---|---|
| Three.js | Three J S | 不读成 "three dot js" |
| Node.js | Node J S | |
| API | A P I | 逐个字母读 |
| .mjs | 点 M J S | 单独出现的扩展名；`serve.mjs` 这类文件名见下面几行（整词匹配，前面紧挨字母时不生效） |
| .js | 点 J S | 同上 |
| .ts | 点 T S | 同上 |
| start.cmd | start 点 cmd | Chlorophyll-Learn 自己的文件，课里会反复出现 |
| serve.mjs | serve 点 M J S | 同上 |
| lesson.js | lesson 点 J S | 同上 |
| events.jsonl | events 点 json L | 同上 |
| Promise.all | Promise 点 all | 不读成 "Promise all" 连读；`Promise.allSettled` 不受影响（整词匹配） |
| client.messages.create | client 点 messages 点 create | Anthropic SDK 的调用 |
| api.anthropic.com | api 点 anthropic 点 com | |
| v1/messages | v1 messages | 单独出现的路径（不带前面的域名） |
| x-api-key | x api key | 请求头名 |
| anthropic-version | anthropic version | 请求头名 |
| stop_reason | stop reason | 下划线不读 |
| max_tokens | max tokens | 同上 |
| RateLimitError | Rate Limit Error | 类名拆成单词读 |
| SDK | S D K | 逐个字母读 |
| 429 | 四二九 | HTTP 状态码按位读 |
| 401 | 四零一 | 同上 |
| 404 | 四零四 | 同上 |
| 405 | 四零五 | 同上 |
| DevTools | Dev Tools | 浏览器开发者工具 |
| F12 | F 十二 | 打开 DevTools 的快捷键 |
| .env | 点 env | 单独出现的文件名（不读成"env"或"点E N V"） |
| events.mjs | events 点 M J S | Chlorophyll-Learn 自己的文件 |
| index.html | index 点 html | |
| /api/event | 斜杠 A P I 斜杠 event | Chlorophyll-Learn 的请求路径 |
| localhost:4321 | localhost 四三二一 | 端口按位读 |
| /today | 斜杠 today | 命令名 |
