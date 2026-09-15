#!/bin/bash
# 构建 WeChat2Agent.app（自包含：内嵌 gateway bundle + node 运行时）
# 用法: app-macos/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/WeChat2Agent.app"

echo "==> 1/4 bundle gateway"
cd "$ROOT/gateway"
mkdir -p "$DIST"
npx esbuild src/index.ts --bundle --platform=node --format=esm \
  --outfile="$DIST/gateway.mjs" \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --log-level=warning

echo "==> 2/4 编译菜单栏面板"
# 显式指定部署目标：swiftc 默认用最新 SDK 版本作 minos（如 28.0），
# 超过当前系统会导致 LaunchServices 拒绝 open（kLSIncompatibleSystemVersionErr -10825）
swiftc -O -target arm64-apple-macosx14.0 "$ROOT/app-macos/menubar.swift" -o "$DIST/wechat2agent"

echo "==> 3/6 生成图标资产"
ICONSET="$DIST/AppIcon.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for spec in "16:16" "32:16x16@2x" "32:32" "64:32x32@2x" "128:128" "256:128x128@2x" "256:256" "512:256x256@2x" "512:512" "1024:512x512@2x"; do
  px="${spec%%:*}"; name="${spec##*:}"
  qlmanage -t -s "$px" -o "$DIST" "$ROOT/app-macos/icons/appicon.svg" > /dev/null 2>&1
  mv "$DIST/appicon.svg.png" "$ICONSET/icon_${name}.png"
done
iconutil -c icns "$ICONSET" -o "$DIST/AppIcon.icns"
# 菜单栏 template 图标（透明背景，系统按明暗模式着色）
for px in 18 36 54; do
  qlmanage -t -s "$px" -o "$DIST" "$ROOT/app-macos/icons/menubar.svg" > /dev/null 2>&1
  mv "$DIST/menubar.svg.png" "$DIST/menubar-${px}.png"
done

echo "==> 4/6 组装 .app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/app-macos/Info.plist" "$APP/Contents/Info.plist"
cp "$DIST/wechat2agent" "$APP/Contents/MacOS/wechat2agent"
cp "$DIST/gateway.mjs" "$APP/Contents/Resources/gateway.mjs"
cp "$DIST/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$DIST"/menubar-*.png "$APP/Contents/Resources/"
# 内嵌当前系统的 node 运行时（注意架构需与目标机器一致，当前为 arm64）
NODE_BIN="$(readlink -f "$(which node)")"
cp "$NODE_BIN" "$APP/Contents/Resources/node"
chmod +x "$APP/Contents/Resources/node"

echo "==> 5/6 ad-hoc 签名"
codesign --force --deep --sign - "$APP" > /dev/null

echo "==> 6/6 完成"
echo "完成: $APP"
echo "  - gateway.mjs: $(du -h "$APP/Contents/Resources/gateway.mjs" | cut -f1)"
echo "  - node: $(du -h "$APP/Contents/Resources/node" | cut -f1)"
echo "  - 总计: $(du -sh "$APP" | cut -f1)"
