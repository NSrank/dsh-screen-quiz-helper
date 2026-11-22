#!/usr/bin/env bash
# 编译原生辅助程序 native/quiznative.swift → bin/quiznative
# 只用系统自带的 Swift 工具链（Xcode Command Line Tools），无第三方依赖。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="native/quiznative.swift"
OUT="bin/quiznative"

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "未找到 swiftc：请先安装 Xcode Command Line Tools（xcode-select --install）" >&2
  exit 1
fi
[ -f "$SRC" ] || { echo "找不到源码 $SRC" >&2; exit 1; }

mkdir -p bin .swiftcache
# 沙箱环境下默认的 /var/folders/.../ModuleCache 可能不可写，这里固定用包内缓存目录
xcrun swiftc -O -module-cache-path ./.swiftcache "$SRC" -o "$OUT"
chmod 755 "$OUT"
echo "已生成 ${OUT} ($(du -h "${OUT}" | cut -f1))"
