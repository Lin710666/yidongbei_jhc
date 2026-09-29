#!/usr/bin/env bash
# 浙里文旅 · 海报与行程 v8.0 —— Linux / macOS 一键启动
#
# 行为与 Windows 的「启动全部.bat」一致：先部署，再启动 + 保活。
set -e
cd "$(dirname "$0")"

echo "=================================================="
echo "  浙里文旅 · 海报与行程  v8.0"
echo "=================================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。装一个：https://nodejs.org （需要 18 以上）"
  exit 1
fi

echo "[1/2] 检查部署..."
# deploy.mjs 每步都会探测是否已就绪，所以重复跑是安全的
if ! node deploy.mjs; then
  echo
  echo "  部署没通过。上面每步都写了原因，修完再跑本脚本即可"
  echo "  （已经就绪的步骤会自动跳过）。"
  exit 1
fi

echo
echo "[2/2] 启动服务..."
echo
echo "  门户      http://127.0.0.1:8800/hub.html"
echo "  海报生成  http://127.0.0.1:8800/"
echo "  旅游规划  http://127.0.0.1:8800/wenlv/"
echo

# 尽力打开浏览器；打不开也不影响服务（服务器可能是无头的）
( xdg-open http://127.0.0.1:8800/hub.html >/dev/null 2>&1 \
  || open http://127.0.0.1:8800/hub.html >/dev/null 2>&1 ) || true

# Ctrl+C 停看守，已起的服务继续跑
exec node start.mjs
