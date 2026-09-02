#!/bin/bash
# build.sh — otterbar Swift 渲染端编译脚本
# 用途：本机编译（Touch Bar 代码依赖 AppKit/macOS，CI（ubuntu）无法编译——与 #713 的
# 本机实测矩阵策略一致）。产物 otterbar-renderer-swift 不入 git（.gitignore 同目录说明），
# 由 launchd plist 启动前调本脚本编译（增量，源码不变时秒过）。
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O main.swift \
  -framework AppKit \
  -F /System/Library/PrivateFrameworks \
  -framework DFRFoundation \
  -o otterbar-renderer-swift
echo "built: $(pwd)/otterbar-renderer-swift"
