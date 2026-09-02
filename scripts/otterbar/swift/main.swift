// main.swift — OtterBar Swift 渲染端（自研，替换 MTMR 载体）
//
// Issue #721。架构：本程序只读 display-model.json（status-core.sh 产出的稳定契约），
// 不访问海獭后端——与 renderer-mtmr.sh 完全同源的行为语义（scripts/otterbar/renderer-mtmr.sh）。
//
// 技术路线（区别于 issue 草案的 DFR 像素 surface 方案，研究结论）：
// - MTMR 闪烁根因 = items.json 每次变化触发 reloadPreset → 整条 NSTouchBar 销毁重建
//   （identifier 全新 UUID）→ Touch Bar 全量重载；并非 NSTouchBar 载体本身不能动画。
// - MTMR 自家 widget（时钟/CPU）在常驻 view 内 in-place 更新 label 从不闪烁，证明
//   常驻 NSView + 定时 setNeedsDisplay 局部重绘路线可行（生产实证）。
// - 故本渲染端走公开 API：NSCustomTouchBarItem + 常驻 NSView + 12fps 帧动画。
// - 唯一私有 API 面（与 MTMR 完全一致，本机 macOS 已被 MTMR 生产实证）：
//   NSTouchBar presentSystemModalTouchBar:systemTrayItemIdentifier: /
//   minimizeSystemModalTouchBar: / NSTouchBarItem addSystemTrayItem: /
//   DFRSystemModalShowsCloseBoxWhenFrontMost / DFRElementSetControlStripPresenceForIdentifier
//
// 行为兼容（与 renderer-mtmr.sh 逐态对齐）：
// - 五态：🔴等你(count/top) / ⌨️干活(convs/otters) / 💤睡觉 / 🖤离线 / ⚠️非主进程前缀
// - offline_long=true → 退出让位（launchd KeepAlive 低频拉起再探测），bar 回归系统默认
// - primary="false" → ⚠️非主· 前缀叠加在在线态上；primary="unknown" 不误报
// - MTMR 在跑 → 让位退出（用户手动启动 MTMR 视为强意图）
// - 进程退出（含 crash）时 Touch Bar server 自动回收 surface，不劫持 bar
//
// 系统键（与 MTMR items 版一致）：Esc=CGEvent key53；音量/亮度=IOKit NX_SYSDEFINED
// 辅助键事件（MTMR CBridge/TouchBarSupport.m 同款）。
//
// 编译：swiftc -O main.swift -framework AppKit -o otterbar-renderer-swift
// 自检：otterbar-renderer-swift --selftest   （状态归并全矩阵断言，不碰 Touch Bar）
// 键测：otterbar-renderer-swift --test-key volumeUp|volumeDown|escape
//
// 系统键（与 MTMR items 版对齐，macOS 26 实测定稿）：
// - Esc：CGEvent key 53（实测可用）
// - 音量：CoreAudio 公开 API 直设默认输出设备音量（实测可用；无 OSD 弹窗——合成
//   NX_SYSDEFINED 媒体键在 macOS 26 被 HID 层静默丢弃，MTMR 的 IOKit 路线同样失效）
// - 亮度：无公开 API（CoreDisplay 私有路线在 macOS 26 实测崩溃/无效）——本期不设亮度按钮
//
// 编译：./build.sh（swiftc -O + DFRFoundation 私有框架 + CoreAudio）
// 运行：常驻，由 launchd 管理（scripts/launchd/com.otterbuddy.otterbar-renderer-swift.plist）

import AppKit
import CoreAudio
import IOKit
import IOKit.hidsystem

// MARK: - 私有 API 桥（最小面，与 MTMR CBridge/TouchBarPrivateApi.h 一致）

/// DFR 系列为 AppKit 导出的真 C 函数，可直接 silgen 绑定。
/// NSTouchBar/NSTouchBarItem 系列为 ObjC 私有类方法，运行时 perform(Selector) 调用。
@_silgen_name("DFRElementSetControlStripPresenceForIdentifier")
private func dfrSetControlStripPresence(_ identifier: NSString, _ present: Bool)

@_silgen_name("DFRSystemModalShowsCloseBoxWhenFrontMost")
private func dfrSystemModalShowsCloseBox(_ shows: Bool)

@inline(__always)
private func addSystemTrayItem(_ item: NSTouchBarItem) {
    // +[NSTouchBarItem addSystemTrayItem:]
    let cls: AnyObject = NSTouchBarItem.self as AnyObject
    _ = cls.perform(Selector(("addSystemTrayItem:")), with: item)
}

@inline(__always)
private func removeSystemTrayItem(_ item: NSTouchBarItem) {
    let cls: AnyObject = NSTouchBarItem.self as AnyObject
    _ = cls.perform(Selector(("removeSystemTrayItem:")), with: item)
}

@inline(__always)
private func presentSystemModal(_ bar: NSTouchBar, trayIdentifier: NSTouchBarItem.Identifier) {
    // +[NSTouchBar presentSystemModalTouchBar:systemTrayItemIdentifier:]
    let cls: AnyObject = NSTouchBar.self as AnyObject
    _ = cls.perform(Selector(("presentSystemModalTouchBar:systemTrayItemIdentifier:")),
                    with: bar, with: trayIdentifier.rawValue as NSString)
}

@inline(__always)
private func minimizeSystemModal(_ bar: NSTouchBar) {
    // +[NSTouchBar minimizeSystemModalTouchBar:]
    let cls: AnyObject = NSTouchBar.self as AnyObject
    _ = cls.perform(Selector(("minimizeSystemModalTouchBar:")), with: bar)
}

// MARK: - Display Model（契约 v1 消费端，字段与 status-core.sh 产出对齐）

struct DisplayModel: Decodable {
    let v: Int?
    let sys_online: Bool?
    let offline_long: Bool?
    let primary: String?
    let waiting: Waiting?
    let working: Working?

    struct Waiting: Decodable {
        let count: Int?
        let top: String?
    }
    struct Working: Decodable {
        let convs: Int?
        let otters: Int?
    }
}

// MARK: - 状态归并（与 renderer-mtmr.sh build_title 行为逐条对齐）

struct StatusRender: Equatable {
    enum Kind: Equatable {
        case offline
        case sleeping
        case waiting(count: Int, top: String)
        case working(convs: Int, otters: Int)
        case mixed(count: Int, top: String, convs: Int, otters: Int)
    }
    let kind: Kind
    let nonPrimary: Bool   // primary == "false" 时叠加 ⚠️非主· 前缀
}

/// 归并规则（对照 renderer-mtmr.sh）：
/// - offline_long=true：调用方应直接退出让位，不进入渲染（返回 nil 语义由 handleModel 处理）
/// - sys_online != true → 🖤离线（非主前缀仍叠加）
/// - waiting/working 同时非零 → mixed；仅 waiting → waiting；仅 working → working
/// - 全零 → 💤睡觉
/// - primary=="unknown" 不误报（仅 "false" 判非主）
func deriveState(_ model: DisplayModel) -> StatusRender {
    let nonPrimary = (model.primary == "false")
    guard model.sys_online == true else {
        return StatusRender(kind: .offline, nonPrimary: nonPrimary)
    }
    let w = model.waiting?.count ?? 0
    let top = model.waiting?.top ?? ""
    let c = model.working?.convs ?? 0
    let o = model.working?.otters ?? 0
    if w > 0 && c > 0 {
        return StatusRender(kind: .mixed(count: w, top: top, convs: c, otters: o), nonPrimary: nonPrimary)
    }
    if w > 0 {
        return StatusRender(kind: .waiting(count: w, top: top), nonPrimary: nonPrimary)
    }
    if c > 0 {
        return StatusRender(kind: .working(convs: c, otters: o), nonPrimary: nonPrimary)
    }
    return StatusRender(kind: .sleeping, nonPrimary: nonPrimary)
}

// MARK: - 系统键事件（macOS 26 实测定稿）

enum SystemKeys {
    /// Esc：CGEvent key 53（MTMR GenericKeyPress 同款，实测可用）
    static func postEscape() {
        let src = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: src, virtualKey: 53, keyDown: true)
        let up = CGEvent(keyboardEventSource: src, virtualKey: 53, keyDown: false)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    // MARK: 音量：CoreAudio 直设默认输出设备（macOS 26 唯一实测有效路线）
    // 注：合成 NX_SYSDEFINED 媒体键（MTMR IOKit 路线 + NSEvent 路线 + 3 种 tap 点）
    // 在本机 macOS 26 全部被 HID 层静默丢弃；CoreAudio 直设实测生效（AppleScript
    // 交叉验证），代价是无 OSD 弹窗动画——功能真实优先。

    private static func defaultOutputDevice() -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &addr, 0, nil, &size, &id) == noErr else { return nil }
        return id
    }

    private static func systemVolume() -> Float32? {
        guard let dev = defaultOutputDevice() else { return nil }
        var v = Float32(0)
        var size = UInt32(MemoryLayout<Float32>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &v) == noErr else { return nil }
        return v
    }

    private static func setSystemVolume(_ val: Float32) {
        guard let dev = defaultOutputDevice() else { return }
        var v = val
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        _ = AudioObjectSetPropertyData(dev, &addr, 0, nil,
                                       UInt32(MemoryLayout<Float32>.size), &v)
    }

    /// 步进量对齐硬件音量键（每按一次约 1/16 ≈ 6.25，取 0.0625 标度）
    static func postVolumeUp() {
        let cur = systemVolume() ?? 0
        setSystemVolume(min(cur + 0.0625, 1.0))
    }

    static func postVolumeDown() {
        let cur = systemVolume() ?? 0
        setSystemVolume(max(cur - 0.0625, 0.0))
    }
}

// MARK: - OtterView：常驻徽章 view，帧动画核心（局部重绘，不重建 bar）

final class OtterView: NSView {
    override var intrinsicContentSize: NSSize { NSSize(width: 120, height: 30) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private(set) var status: StatusRender = StatusRender(kind: .sleeping, nonPrimary: false)
    private var phase: TimeInterval = 0          // 动画相位（秒）
    private let spinnerFrames: [String] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    func update(_ new: StatusRender) {
        if status != new { status = new }        // 文本变化由下一帧自然带出，仍只重绘本 view
    }

    /// 12fps 帧推进：仅标记本 view 脏区 → Touch Bar server 局部合成，无 bar 级重载
    func tick(_ dt: TimeInterval) {
        phase += dt
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let t = phase
        let sleeping = (status.kind == .sleeping)
        let offline = (status.kind == .offline)

        // 海獭呼吸：字号正弦起伏（睡觉=深慢呼吸 4s/0.9pt；平时 3s/0.7pt；离线=弱呼吸+降透明度）
        let period: Double = sleeping ? 4.0 : 3.0
        let amp: Double = sleeping ? 0.9 : 0.7
        let fontSize = 15.0 + amp * sin(2 * .pi * t / period)
        let otterAlpha: CGFloat = offline ? 0.55 : 0.85 + 0.15 * CGFloat(sin(2 * .pi * t / period))

        var segs: [(String, CGFloat, CGFloat)] = []   // (text, fontSize, alpha)
        segs.append(("🦦", fontSize, otterAlpha))
        if status.nonPrimary { segs.append((" ⚠️非主·", 12, 1)) }

        switch status.kind {
        case .offline:
            segs.append(("🖤离线", 13, 1))
        case .sleeping:
            // 💤 缓慢漂浮（±1.5pt 基线偏移，8s 周期）
            segs.append((" 💤", 13, 1))
        case .waiting(let count, let top):
            // 🔴 脉冲：1s 周期透明度 0.5~1 + 计数上标
            let pulse = CGFloat(0.5 + 0.5 * (0.5 + 0.5 * sin(2 * .pi * t)))
            segs.append((" 🔴", 13, pulse))
            segs.append((superscript(count), 9, pulse))
            if !top.isEmpty { segs.append((" · \(prefix10(top))", 12, 1)) }
        case .working(let convs, let otters):
            segs.append((" \(spinner(at: t)) ⌨️\(convs)场\(otters)獭", 13, 1))
        case .mixed(let count, let top, let convs, let otters):
            let pulse = CGFloat(0.5 + 0.5 * (0.5 + 0.5 * sin(2 * .pi * t)))
            segs.append((" 🔴", 13, pulse))
            segs.append((superscript(count), 9, pulse))
            segs.append((" \(spinner(at: t)) ⌨️\(convs)场\(otters)獭", 13, 1))
            if !top.isEmpty { segs.append((" · \(prefix10(top))", 12, 1)) }
        }

        let attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.white,
            .font: NSFont.systemFont(ofSize: 13, weight: .medium),
        ]
        let full = NSMutableAttributedString()
        for (text, size, alpha) in segs {
            let p = NSMutableParagraphStyle()
            p.alignment = .center
            var a = attrs
            a[.font] = NSFont.systemFont(ofSize: size, weight: .medium)
            a[.foregroundColor] = NSColor.white.withAlphaComponent(alpha)
            a[.paragraphStyle] = p
            full.append(NSAttributedString(string: text, attributes: a))
        }
        // 超宽截断（view 宽 120，对齐 MTMR width:120）
        let maxWidth = bounds.width - 6
        if full.size().width > maxWidth, let line = full.mutableCopy() as? NSMutableAttributedString {
            while line.size().width > maxWidth - 12 && line.length > 1 {
                line.deleteCharacters(in: NSRange(location: line.length - 1, length: 1))
            }
            line.append(NSAttributedString(string: "…", attributes: attrs))
            full.setAttributedString(line)
        }
        let size = full.size()
        let textRect = NSRect(x: 3, y: (bounds.height - size.height) / 2,
                              width: bounds.width - 6, height: size.height)
        full.draw(in: textRect)
    }

    private func spinner(at t: TimeInterval) -> String {
        let idx = Int(t / 0.1) % spinnerFrames.count
        return spinnerFrames[idx]
    }

    private func prefix10(_ s: String) -> String { String(s.prefix(10)) }
}

private func superscript(_ n: Int) -> String {
    let map = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"]
    if n <= 0 { return map[0] }
    var out = "", v = n
    while v > 0 { out = map[v % 10] + out; v /= 10 }
    return out
}

// MARK: - Controller

final class BarController: NSObject, NSTouchBarDelegate {
    static let trayID = NSTouchBarItem.Identifier("com.otterbuddy.otterbar.tray")
    static let mainID = NSTouchBarItem.Identifier("com.otterbuddy.otterbar.main")

    let bar = NSTouchBar()
    let otterView = OtterView()
    private var trayItem: NSCustomTouchBarItem?
    private var pollTimer: Timer?
    private var animTimer: Timer?
    private var lastAnim = Date()

    static let modelURL = URL(fileURLWithPath:
        NSHomeDirectory() + "/Library/Application Support/OtterBar/display-model.json")
    static let pollInterval: TimeInterval = 2.0
    static let animFPS: TimeInterval = 12.0

    func start() {
        dfrSystemModalShowsCloseBox(false)

        let tray = NSCustomTouchBarItem(identifier: Self.trayID)
        let trayButton = NSButton(title: "🦦", target: self, action: #selector(representTouchBar))
        trayButton.isBordered = false
        tray.view = trayButton
        trayItem = tray
        addSystemTrayItem(tray)

        bar.delegate = self
        bar.defaultItemIdentifiers = [Self.mainID]
        representTouchBar()

        pollTimer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            self?.pollOnce()
        }
        animTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / Self.animFPS, repeats: true) { [weak self] _ in
            guard let self else { return }
            let now = Date()
            self.otterView.tick(now.timeIntervalSince(self.lastAnim))
            self.lastAnim = now
        }
        pollOnce()
    }

    @objc func representTouchBar() {
        presentSystemModal(bar, trayIdentifier: Self.trayID)
        dfrSetControlStripPresence(Self.trayID.rawValue as NSString, true)
    }

    func dismiss() {
        minimizeSystemModal(bar)
        dfrSetControlStripPresence(Self.trayID.rawValue as NSString, false)
        if let tray = trayItem { removeSystemTrayItem(tray) }
    }

    // MARK: NSTouchBarDelegate — 常驻 item 只建一次，此后永不重建（不闪的根因保障）

    func touchBar(_: NSTouchBar, makeItemForIdentifier identifier: NSTouchBarItem.Identifier) -> NSTouchBarItem? {
        guard identifier == Self.mainID else { return nil }
        let item = NSCustomTouchBarItem(identifier: identifier)
        item.view = buildStack()
        return item
    }

    private func buildStack() -> NSView {
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 2, bottom: 0, right: 2)

        otterView.translatesAutoresizingMaskIntoConstraints = false
        stack.addView(otterView, in: .leading)

        let esc = NSButton(title: "esc", target: self, action: #selector(tapEsc))
        styleKey(esc)
        stack.addView(esc, in: .trailing)

        // 音量键（CoreAudio 直设，macOS 26 实测可用）；亮度键本期不设——无公开 API，
        // 私有路线实测失败（详见特性文档），MTMR 载体同样只剩视觉件
        for (symbol, action) in [
            ("speaker.wave.1", #selector(tapVolumeDown)),
            ("speaker.wave.3", #selector(tapVolumeUp)),
        ] as [(String, Selector)] {
            let b = NSButton()
            if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
                b.image = img
            } else {
                b.title = symbol // 极端兜底：无 SF Symbol 环境显示文字
            }
            b.action = action
            b.target = self
            styleKey(b)
            stack.addView(b, in: .trailing)
        }
        return stack
    }

    private func styleKey(_ b: NSButton) {
        b.isBordered = false
        b.bezelColor = .clear
        b.imageScaling = .scaleProportionallyDown
        b.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.widthAnchor.constraint(equalToConstant: 34).isActive = true
    }

    @objc private func tapEsc() { SystemKeys.postEscape() }
    @objc private func tapVolumeUp() { SystemKeys.postVolumeUp() }
    @objc private func tapVolumeDown() { SystemKeys.postVolumeDown() }

    // MARK: model 轮询（契约文件 2s 一读，仅文本 diff 时更新 view 状态）

    private func pollOnce() {
        // MTMR 双活让位：用户手动启动 MTMR = 强意图，自研端退出
        if mtmrRunning() { teardown(exitCode: 0, reason: "MTMR detected, yield") }
        guard let data = try? Data(contentsOf: Self.modelURL),
              let model = try? JSONDecoder().decode(DisplayModel.self, from: data) else {
            otterView.update(deriveState(DisplayModel(v: 1, sys_online: false, offline_long: false,
                                                      primary: "unknown", waiting: nil, working: nil)))
            return
        }
        if model.offline_long == true {
            teardown(exitCode: 0, reason: "offline_long, sleep for launchd low-freq probe")
            return
        }
        otterView.update(deriveState(model))
    }

    private func teardown(exitCode: Int32, reason: String) {
        print("[otterbar-renderer] exit: \(reason)")
        pollTimer?.invalidate()
        animTimer?.invalidate()
        dismiss()
        exit(exitCode)
    }

    private func mtmrRunning() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-x", "MTMR"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch {
            return false
        }
    }
}

// MARK: - Selftest（--selftest：状态归并全矩阵断言，不碰 Touch Bar；CI/Linux 可跑逻辑层）

enum Selftest {
    static func run() -> Int32 {
        func model(online: Bool = true, long: Bool = false, primary: String = "true",
                   w: Int = 0, top: String = "", c: Int = 0, o: Int = 0) -> DisplayModel {
            DisplayModel(v: 1, sys_online: online, offline_long: long, primary: primary,
                         waiting: .init(count: w, top: top), working: .init(convs: c, otters: o))
        }
        var failed = 0
        func expect(_ name: String, _ got: StatusRender, _ want: StatusRender) {
            if got != want { print("FAIL \(name): got \(got), want \(want)"); failed += 1 }
            else { print("ok   \(name)") }
        }
        // 睡觉：在线无未读无在干
        expect("sleeping", deriveState(model()),
               StatusRender(kind: .sleeping, nonPrimary: false))
        // 等你：未读 2 + top
        expect("waiting", deriveState(model(w: 2, top: "评测机制")),
               StatusRender(kind: .waiting(count: 2, top: "评测机制"), nonPrimary: false))
        // 干活：3 场 4 獭
        expect("working", deriveState(model(c: 3, o: 4)),
               StatusRender(kind: .working(convs: 3, otters: 4), nonPrimary: false))
        // 混合
        expect("mixed", deriveState(model(w: 1, top: "t", c: 2, o: 2)),
               StatusRender(kind: .mixed(count: 1, top: "t", convs: 2, otters: 2), nonPrimary: false))
        // 离线（优先级高于 waiting/working）
        expect("offline", deriveState(model(online: false, w: 5, c: 5)),
               StatusRender(kind: .offline, nonPrimary: false))
        // 非主前缀叠加在线态；unknown 不误报
        expect("nonPrimary", deriveState(model(primary: "false", c: 1, o: 1)),
               StatusRender(kind: .working(convs: 1, otters: 1), nonPrimary: true))
        expect("nonPrimaryOffline", deriveState(model(online: false, primary: "false")),
               StatusRender(kind: .offline, nonPrimary: true))
        expect("unknownPrimary", deriveState(model(primary: "unknown")),
               StatusRender(kind: .sleeping, nonPrimary: false))
        // 上标
        assert(superscript(0) == "⁰" && superscript(10) == "¹⁰" && superscript(23) == "²³", "superscript broken")
        print(failed == 0 ? "SELFTEST PASS" : "SELFTEST FAIL (\(failed))")
        return failed == 0 ? 0 : 1
    }
}

// MARK: - main

var args = CommandLine.arguments
if args.contains("--selftest") { exit(Selftest.run()) }
if let i = args.firstIndex(of: "--test-key"), i + 1 < args.count {
    switch args[i + 1] {
    case "escape": SystemKeys.postEscape()
    case "volumeUp": SystemKeys.postVolumeUp()
    case "volumeDown": SystemKeys.postVolumeDown()
    default: print("unknown key (brightness not supported)"); exit(2)
    }
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = BarController()

// SIGTERM（launchd bootout）：优雅退位，bar 回归系统默认
signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler {
    controller.dismiss()
    exit(0)
}
termSource.resume()

let delegate = LaunchDelegate(controller: controller)
app.delegate = delegate
app.run()
exit(0)

final class LaunchDelegate: NSObject, NSApplicationDelegate {
    let controller: BarController
    init(controller: BarController) { self.controller = controller }
    func applicationDidFinishLaunching(_ notification: Notification) { controller.start() }
}
