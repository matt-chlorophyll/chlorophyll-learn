#!/bin/sh
# 启动 Chlorophyll-Learn（macOS、Linux）：启动本地服务器（已在运行则跳过），然后打开 hub
# 也可以带一个路径（开头不加 /）：./start.sh lessons/<topic>/w01/d1/
# 端口取环境变量 PORT，其次 .env 里的 PORT，默认 4321
cd "$(dirname "$0")" || exit 1
[ -z "$PORT" ] && [ -f .env ] && PORT="$(grep -E '^PORT=' .env | tail -n 1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-4321}"
if ! curl -s -m 2 "http://127.0.0.1:$PORT/api/health" | grep -q chlorophyll-learn; then
  mkdir -p .tmp
  PORT="$PORT" nohup node tools/serve.mjs > .tmp/server.log 2>&1 &
  sleep 1
  echo "服务器已在后台启动（日志：.tmp/server.log）。停止：kill $!"
fi
URL="http://localhost:$PORT/$1"
if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
else echo "用浏览器打开：$URL"
fi
