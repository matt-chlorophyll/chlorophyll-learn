#!/bin/sh
# 启动 Chlorophyll-Learn（macOS、Linux）：启动本地服务器（已在运行则跳过），然后打开 hub
# 也可以带一个路径（开头不加 /）：./start.sh lessons/<topic>/w01/d1/
# 端口取环境变量 PORT，其次 .env 里的 PORT，默认 4321
cd "$(dirname "$0")" || exit 1
[ -z "$PORT" ] && [ -f .env ] && PORT="$(grep -E '^PORT=' .env | tail -n 1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-4321}"
up() { curl -s -m 2 "http://127.0.0.1:$PORT/api/health" | grep -q chlorophyll-learn; }
if ! up; then
  if ! command -v node >/dev/null 2>&1; then
    echo "找不到 node：先装 Node.js 22 或更新的版本（https://nodejs.org ，选 LTS），装好后打开一个新的终端窗口，再运行 ./start.sh"
    exit 1
  fi
  if ! node -e 'process.exit(parseInt(process.versions.node) < 22 ? 1 : 0)'; then
    echo "Node.js 版本太旧（$(node -v)），需要 22 或更新：到 https://nodejs.org 装 LTS 版，再运行 ./start.sh"
    exit 1
  fi
  mkdir -p .tmp
  PORT="$PORT" nohup node tools/serve.mjs > .tmp/server.log 2>&1 &
  pid=$!
  # 等服务器能响应再开浏览器，最多约 10 秒；进程提前退出就不用等了
  i=0
  until up; do
    i=$((i + 1))
    if [ "$i" -gt 20 ] || ! kill -0 "$pid" 2>/dev/null; then
      echo "服务器没有启动起来。日志 .tmp/server.log 的最后几行："
      tail -n 15 .tmp/server.log
      exit 1
    fi
    sleep 0.5
  done
  echo "服务器已在后台启动（日志：.tmp/server.log）。停止：kill $pid"
fi
URL="http://localhost:$PORT/$1"
if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
else echo "用浏览器打开：$URL"
fi
