---
id: F20260921otbr
title: otterbar MTMR 检测去子进程化
summary: mtmrRunning() 从每次 poll 的 pgrep fork（Process + waitUntilExit 同步阻塞）改为 NSWorkspace.shared.runningApplications 内存查询（bundleId/localizedName 匹配），消除 2s 周期的子进程开销与主线程阻塞风险（#742）。
change_type: refactor
capability_test: "n/a: Swift 渲染端性能改动，无 LLM 参与行为；逻辑层 selftest 全过"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [otterbar, performance, macos]
modules: [scripts/otterbar/swift/main.swift]
---

# otterbar MTMR 检测去子进程化（#742）

## 背景

PR #737 检视（检视獭-Swift2 建议发现 2）：`mtmrRunning()` 每次 pollOnce()（2s 周期）`Process()` + `/usr/bin/pgrep` fork 子进程——单次开销小，但在 12fps 动画循环旁频繁 fork 有轻微开销；更实质的是 `waitUntilExit()` 同步阻塞，pgrep 极端挂起会阻塞主线程（AppKit 全局实例主线程约束下风险放大）。

## 改动

issue 建议方案 2（NSWorkspace.runningApplications）落地，方案 1（降频）不需要了——方案 2 把开销降到内存查询，降频失去意义：

```swift
// 旧：Process() + pgrep -x MTMR + waitUntilExit()（每 2s fork）
// 新：NSWorkspace.shared.runningApplications 内存查询
apps.contains {
    $0.bundleIdentifier == "org.mtmr.MTMR"
        || $0.bundleIdentifier == "MTMR"
        || $0.localizedName == "MTMR"
}
```

### 匹配语义说明

- `pgrep -x MTMR` 按精确进程名匹配；`runningApplications` 无 guaranteed 精确进程名字段，用 bundleId（MTMR 官方分发 org.mtmr.MTMR）为主、localizedName 为兜底
- 双字段 OR 保持同等灵敏度（误让位比误退出代价低——MTMR 检测是「用户强意图让位」语义，漏检会让双活条叠屏，误检只是自研端退出）

## 已知边界

- Homebrew/自编译 MTMR 无签名 bundleId 时依赖 localizedName 兜底——极端情况（改了 app 名）漏检，恢复形态：launchd 低频探测会重启自研端，非永久丢失
- NSWorkspace 查询要求 AppKit 上下文——本文件本就是 NSApplication 结构（main.swift:788），无条件满足

## 验证

- `build.sh` 真实编译链通过（swiftc -O + DFRFoundation 私有框架，产物 159KB）
- `--selftest` 状态归并全矩阵断言 PASS（逻辑层，不碰 Touch Bar）
- CI（ubuntu）不编译 Swift——与 #713 本机实测矩阵策略一致，依赖本机验证

## Modification-Class

`narrow-fix`（既有检测语义内替换实现，无新机制）
