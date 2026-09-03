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
//
// 系统键：不集成（搭档验收 22:24 决策）——Swift 端作为应用加入 bar 时，系统自带
// 原生控制条（esc/音量/亮度）仍然可用，我们在 view 里再集成一遍是冗余。研究结论
// 留档：合成媒体键在 macOS 26 被 HID 层静默丢弃，CoreAudio 直设可用（历史验证
// 见 F20260902swft 首版验证表）。
//
// 编译：./build.sh（swiftc -O + DFRFoundation 私有框架）
// 运行：常驻，由 launchd 管理（scripts/launchd/com.otterbuddy.otterbar-renderer-swift.plist）

import AppKit
import IOKit

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

// MARK: - OtterView：常驻徽章 view，帧动画核心（局部重绘，不重建 bar）

// OtterView v2 —— 方案 A「小海獭徽章」实现（设计獭-水獭 规格，F20260902swft）
// 视觉语言：左侧 26pt 矢量海獭头像 + 状态环（颜色编码状态，动态编码活跃度）
// → 中部数据区（大数字/点阵）→ 右侧会话名。0.5s 辨识链：颜色 → 环动态 → 数字。
// 色板（黑底校准）：琥珀 #FFB454（等你）/ 青 #45D6BD（干活）/ 夜蓝 #6B7FA3（睡觉）/
// 灰 #8E8E96（失联）/ 暗红 #C05A5A（心跳描边）/ 脸棕 #A9825F / 吻 #D8BE9F / 眼鼻 #2E2218

final class OtterView: NSView {
    override var intrinsicContentSize: NSSize { NSSize(width: 160, height: 30) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private(set) var status: StatusRender = StatusRender(kind: .sleeping, nonPrimary: false)
    private var phase: TimeInterval = 0
    private var lastBlink: TimeInterval = 2.0     // 上次眨眼时刻
    private var blinkUntil: TimeInterval = -1     // 眨眼闭眼截止时刻
    private var nextBlinkAt: TimeInterval = 3.5   // 下次眨眼调度

    // 色板
    private let cAmber = NSColor(srgbRed: 1.0, green: 0.706, blue: 0.329, alpha: 1)
    private let cTeal = NSColor(srgbRed: 0.271, green: 0.839, blue: 0.741, alpha: 1)
    private let cNightBlue = NSColor(srgbRed: 0.420, green: 0.498, blue: 0.639, alpha: 1)
    private let cGray = NSColor(srgbRed: 0.557, green: 0.557, blue: 0.588, alpha: 1)
    private let cDarkRed = NSColor(srgbRed: 0.753, green: 0.353, blue: 0.353, alpha: 1)
    private let cFur = NSColor(srgbRed: 0.663, green: 0.510, blue: 0.373, alpha: 1)
    private let cMuzzle = NSColor(srgbRed: 0.847, green: 0.745, blue: 0.624, alpha: 1)
    private let cEye = NSColor(srgbRed: 0.180, green: 0.133, blue: 0.094, alpha: 1)

    func update(_ new: StatusRender) {
        if status != new { status = new }        // 变化由下一帧自然带出，仅重绘本 view
    }

    /// 12fps 帧推进：仅标记本 view 脏区 → Touch Bar server 局部合成，无 bar 级重载
    func tick(_ dt: TimeInterval) {
        phase += dt
        needsDisplay = true
    }

    // MARK: 帧动画参数（全部正弦缓动，周期 ≥1.2s —— 12fps 下的优雅约束）

    private func sin01(_ t: TimeInterval, period: Double) -> Double {
        0.5 + 0.5 * sin(2 * .pi * Double(t) / period)
    }

    /// 眨眼调度：每 3.5s±0.8s 一次，闭眼 2 帧（~166ms）
    private var eyesClosed: Bool {
        let awake = !(status.kind == .sleeping || status.kind == .offline)
        guard awake else { return true }
        if blinkUntil > phase { return true }     // 闭眼窗口内
        if phase >= nextBlinkAt {                 // 触发眨眼
            blinkUntil = phase + 0.17
            nextBlinkAt = phase + 3.5 + Double.random(in: -0.8...0.8)
            return true
        }
        return false
    }

    // MARK: 绘制

    override func draw(_ dirtyRect: NSRect) {
        let t = phase
        let kind = status.kind
        let sleeping = kind == .sleeping
        let offline = kind == .offline

        // ── 左：海獭头像 + 状态环（圆心 15,15，脸 r9，环 r12）──
        let center = CGPoint(x: 15, y: 15)
        drawStatusRing(center: center, t: t, kind: kind)
        drawOtterFace(center: center, sleeping: sleeping, offline: offline,
                      blink: eyesClosed, t: t)
        if sleeping { drawZZ(center: center, t: t) }
        if offline { drawBrokenHeart(center: CGPoint(x: 26, y: 22)) }

        // 混合态：右下青色角标（干活存在感）
        if case .mixed = kind { drawTealCorner(center: center, t: t) }

        // ── 中+右：数据区 ──
        let textX: CGFloat = 36
        let textW = bounds.width - textX - 4
        drawDataArea(x: textX, w: textW, kind: kind, nonPrimary: status.nonPrimary, t: t)
    }

    // 状态环
    private func drawStatusRing(center: CGPoint, t: TimeInterval, kind: StatusRender.Kind) {
        let rect = NSRect(x: center.x - 12, y: center.y - 12, width: 24, height: 24)
        let path = NSBezierPath(ovalIn: rect)
        path.lineCapStyle = .round

        switch kind {
        case .waiting, .mixed:
            // 琥珀呼吸：环宽 1.8↔2.6pt + 透明度 0.65↔1.0 / 1.7s
            let b = sin01(t, period: 1.7)
            cAmber.withAlphaComponent(0.65 + 0.35 * CGFloat(b)).setStroke()
            path.lineWidth = 1.8 + 0.8 * CGFloat(b)
            path.stroke()
        case .working:
            // 青色单弧：弧长 160°↔300° 往复 / 2.8s + 慢旋转 80°/s（每帧 6.7°）
            let grow = sin01(t, period: 2.8)
            let sweep = 160.0 + 140.0 * grow
            let start = -90.0 + (t * 80.0).truncatingRemainder(dividingBy: 360.0)
            let arc = NSBezierPath()
            arc.appendArc(withCenter: center, radius: 12,
                          startAngle: start, endAngle: start + sweep)
            arc.lineCapStyle = .round
            cTeal.setStroke()
            arc.lineWidth = 2.2
            arc.stroke()
        case .sleeping:
            // 夜蓝极慢浮动：透明度 0.18↔0.28 / 9s（几乎静止——睡觉就要像睡觉）
            let b = sin01(t, period: 9.0)
            cNightBlue.withAlphaComponent(0.18 + 0.10 * CGFloat(b)).setStroke()
            path.lineWidth = 1.6
            path.stroke()
        case .offline:
            // 灰虚线静止
            cGray.withAlphaComponent(0.5).setStroke()
            path.setLineDash([3, 3], count: 2, phase: 0)
            path.lineWidth = 1.5
            path.stroke()
        }
    }

    // 海獭脸 v2「海獭相」（设计獭规格）：扁宽脸+小贴耳+大扁鼻+白胡须+微笑弧
    // 局部坐标系 26×26pt（原点左上、y 向下，映射到 view 时 y 翻转）
    // 绘制顺序：耳（被脸盖下缘）→ 脸 → 吻 → 鼻 → 嘴 → 眼 → 胡须（永远最上层）
    private let showWhiskers = true   // 真机保险丝：26pt 下糊则置 false 或降为 2 根

    private func drawOtterFace(center: CGPoint, sleeping: Bool, offline: Bool, blink: Bool, t: TimeInterval) {
        let ox = center.x - 13
        let oy = center.y - 13
        func rectC(_ cx: CGFloat, _ cy: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
            NSRect(x: ox + cx - w / 2, y: oy + (26 - cy) - h / 2, width: w, height: h)
        }
        func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: ox + x, y: oy + (26 - y))
        }

        // v2 色板：深棕脸 #8F6B4A / 浅吻 #E3C9A8（离线灰剪影）
        let fur = offline ? cGray.withAlphaComponent(0.4)
                          : NSColor(srgbRed: 0.561, green: 0.420, blue: 0.290, alpha: 1)
        let muzzleC = offline ? cGray.withAlphaComponent(0.28)
                              : NSColor(srgbRed: 0.890, green: 0.790, blue: 0.659, alpha: 1)
        let inkC = offline ? NSColor(white: 0.23, alpha: 0.7) : cEye

        // 耳：r1.3 小贴耳（先画，脸盖掉下缘只露小凸起——熊耳是「像熊」头号元凶）
        for ex in [5.2, 20.8] {
            let ear = NSBezierPath(ovalIn: rectC(ex, 5.2, 2.6, 2.6))
            fur.setFill()
            ear.fill()
        }

        // 脸：椭圆 21×19（宽>高=鼬科扁宽脸盘）
        let face = NSBezierPath(ovalIn: rectC(13, 14.5, 21, 19))
        fur.setFill()
        face.fill()

        // 吻/脸颊：椭圆 9.5×7 提亮（深头浅吻强对比）
        let muzzle = NSBezierPath(ovalIn: rectC(13, 18, 9.5, 7))
        muzzleC.setFill()
        muzzle.fill()

        // 鼻：横向大扁鼻 3.6×2.6（海獭最强辨识符号）
        let nose = NSBezierPath(ovalIn: rectC(13, 15.8, 3.6, 2.6))
        inkC.setFill()
        nose.fill()

        // 嘴：鼻下 2.8pt 微笑弧（温和感=伙伴人格）
        let mouth = NSBezierPath()
        mouth.move(to: pt(11.6, 18.4))
        mouth.curve(to: pt(14.4, 18.4),
                    controlPoint1: pt(12.3, 19.3),
                    controlPoint2: pt(13.7, 19.3))
        inkC.withAlphaComponent(0.85).setStroke()
        mouth.lineWidth = 0.7
        mouth.lineCapStyle = .round
        mouth.stroke()

        // 眼：r1.5 略小略拢（给大鼻和胡须让视觉权重）；闭眼=圆角横线
        for ex in [8.8, 17.2] {
            if sleeping || blink {
                let line = NSBezierPath(roundedRect: rectC(ex, 12, 3.2, 1.5), xRadius: 0.75, yRadius: 0.75)
                inkC.setFill()
                line.fill()
            } else {
                let eye = NSBezierPath(ovalIn: rectC(ex, 12, 3.0, 3.0))
                inkC.setFill()
                eye.fill()
            }
        }

        // 胡须：每侧 3 根白线（起点藏进吻部，黑底白须辨识度最高）
        if showWhiskers && !offline {
            NSColor.white.withAlphaComponent(0.6).setStroke()
            let whiskerLen: CGFloat = 6.0
            for side in [CGFloat(1), CGFloat(-1)] {
                let baseX: CGFloat = 8.4 + (side > 0 ? 0 : 0) // 左侧起点 x（右侧镜像）
                let anchor = side > 0 ? { (dx: CGFloat, dy: CGFloat) in NSPoint(x: baseX + dx, y: 17.8 + dy) }
                                      : { (dx: CGFloat, dy: CGFloat) in NSPoint(x: 26 - baseX - dx, y: 17.8 + dy) }
                let angles: [CGFloat] = [0, 14, -14]   // 中平/上斜/下斜（度）
                for deg in angles {
                    let rad = deg * .pi / 180 * side
                    let x0 = anchor(0, 0).x
                    let y0 = anchor(0, 0).y
                    let x1 = x0 - whiskerLen * cos(rad) * side
                    let y1 = y0 + whiskerLen * sin(rad)
                    let w = NSBezierPath()
                    w.move(to: pt(x0, y0))
                    w.line(to: pt(x1, y1))
                    w.lineWidth = 0.8
                    w.lineCapStyle = .round
                    w.stroke()
                }
            }
        }
    }

    // zZ 上浮（双字，9/7pt，斜体），透明度 0→0.35→0 / 5s，相位差 2.5s
    // 注：NSFontManager.shared 仅在主线程 draw(_:) 中调用（AppKit 全局实例线程约束）
    private func drawZZ(center: CGPoint, t: TimeInterval) {
        for (i, size) in [9.0, 7.0].enumerated() {
            let tt = t + Double(i) * 2.5
            let cyc = (tt / 5.0).truncatingRemainder(dividingBy: 1.0)
            let rise = cyc * 7.0
            let alpha = sin(CGFloat(cyc) * .pi) * 0.35
            let font = NSFontManager.shared.convert(
                NSFont.systemFont(ofSize: CGFloat(size)), toHaveTrait: .italicFontMask)
            let z = NSAttributedString(string: "z", attributes: [
                .font: font,
                .foregroundColor: NSColor.white.withAlphaComponent(alpha),
            ])
            let pt = NSPoint(x: center.x + 10 + CGFloat(i) * 5,
                             y: center.y + 8 + CGFloat(rise) * 0.4)
            z.draw(at: pt)
        }
    }

    // 离线：矢量黑心（黑填充 + 暗红描边），透明度 0.5→0.8→0.5 / 4s——最后的心跳
    private func drawBrokenHeart(center: CGPoint) {
        let t = phase
        let b = 0.5 + 0.5 * sin(2 * .pi * Double(t) / 4.0)
        let alpha = 0.5 + 0.3 * CGFloat(b)
        let w: CGFloat = 10, h: CGFloat = 9
        let x = center.x - w / 2, y = center.y - h / 2
        let path = NSBezierPath()
        // 标准 cubic 心形：左瓣→右瓣→底尖
        path.move(to: NSPoint(x: x + w * 0.5, y: y + h * 0.85))
        path.curve(to: NSPoint(x: x, y: y + h * 0.35),
                   controlPoint1: NSPoint(x: x + w * 0.18, y: y + h * 1.05),
                   controlPoint2: NSPoint(x: x, y: y + h * 0.6))
        path.curve(to: NSPoint(x: x + w * 0.5, y: y),
                   controlPoint1: NSPoint(x: x, y: y + h * 0.12),
                   controlPoint2: NSPoint(x: x + w * 0.28, y: y))
        path.curve(to: NSPoint(x: x + w, y: y + h * 0.35),
                   controlPoint1: NSPoint(x: x + w * 0.72, y: y),
                   controlPoint2: NSPoint(x: x + w, y: y + h * 0.12))
        path.curve(to: NSPoint(x: x + w * 0.5, y: y + h * 0.85),
                   controlPoint1: NSPoint(x: x + w, y: y + h * 0.6),
                   controlPoint2: NSPoint(x: x + w * 0.82, y: y + h * 1.05))
        path.close()
        NSColor.black.withAlphaComponent(alpha).setFill()
        path.fill()
        cDarkRed.withAlphaComponent(alpha).setStroke()
        path.lineWidth = 1.0
        path.stroke()
    }

    // 混合态：右下青色角标（r3.5 + 黑描边），透明度 0.7↔1.0 / 2.2s
    private func drawTealCorner(center: CGPoint, t: TimeInterval) {
        let b = sin01(t, period: 2.2)
        let c = CGPoint(x: center.x + 8, y: center.y - 8)
        let dot = NSBezierPath(ovalIn: NSRect(x: c.x - 3.5, y: c.y - 3.5, width: 7, height: 7))
        cTeal.withAlphaComponent(0.7 + 0.3 * CGFloat(b)).setFill()
        dot.fill()
        NSColor.black.setStroke()
        dot.lineWidth = 1.5
        dot.stroke()
    }

    // 数据区：大数字 / 点阵 / 状态词 + 会话名
    private func drawDataArea(x: CGFloat, w: CGFloat, kind: StatusRender.Kind,
                              nonPrimary: Bool, t: TimeInterval) {
        let midY = bounds.height / 2

        // 非主前缀：琥珀描边胶囊「非主」+ 竖分隔线（宽度 30pt，从数据区左侧扣）
        var cursorX = x
        if nonPrimary {
            drawNonPrimaryPill(x: cursorX, y: midY)
            // 竖分隔线
            let sep = NSBezierPath()
            sep.move(to: NSPoint(x: cursorX + 32, y: midY - 7))
            sep.line(to: NSPoint(x: cursorX + 32, y: midY + 7))
            NSColor.white.withAlphaComponent(0.2).setStroke()
            sep.lineWidth = 1
            sep.stroke()
            cursorX += 38
        }

        switch kind {
        case .waiting(let count, let top), .mixed(let count, let top, _, _):
            // 大数字 19pt mono semibold + 「条未读」9.5pt 白60% + 会话名右对齐
            let numFont = NSFont.monospacedDigitSystemFont(ofSize: 19, weight: .semibold)
            let num = NSAttributedString(string: "\(count)", attributes: [
                .font: numFont, .foregroundColor: NSColor.white,
            ])
            let unit = NSAttributedString(string: " 条未读", attributes: [
                .font: NSFont.systemFont(ofSize: 9.5),
                .foregroundColor: NSColor.white.withAlphaComponent(0.6),
                .baselineOffset: 1.5,
            ])
            let line = NSMutableAttributedString(attributedString: num)
            line.append(unit)
            let lineSize = line.size()
            line.draw(at: NSPoint(x: cursorX, y: midY - lineSize.height / 2))
            // 会话名（右对齐，超宽截 6 字）
            if !top.isEmpty {
                let name = String(top.prefix(nonPrimary ? 4 : 6))
                let nameAttr = NSAttributedString(string: name, attributes: [
                    .font: NSFont.systemFont(ofSize: 10.5),
                    .foregroundColor: NSColor.white.withAlphaComponent(0.65),
                    .kern: 0.2,
                ])
                let ns = nameAttr.size()
                let nx = x + w - ns.width
                if nx > cursorX + lineSize.width + 8 {
                    nameAttr.draw(at: NSPoint(x: nx, y: midY - ns.height / 2))
                }
            }
        case .working(_, let otters):
            // 点阵（1 点 = 1 獭，≤6，4pt 圆点间距 7pt，逐点脉冲波 0.45↔1.0 间隔 0.25s）+ n獭·m话
            let n = min(otters, 6)
            let dotStart = cursorX + 2
            for i in 0..<n {
                let wave = sin01(t - Double(i) * 0.25, period: 1.2)
                let alpha = 0.45 + 0.55 * CGFloat(max(0, wave))
                let dx = dotStart + CGFloat(i) * 7
                let dot = NSBezierPath(ovalIn: NSRect(x: dx, y: midY - 2, width: 4, height: 4))
                cTeal.withAlphaComponent(alpha).setFill()
                dot.fill()
            }
            let textX2 = dotStart + CGFloat(n) * 7 + 6
            if case .working(let convs, _) = kind {
                let label = NSAttributedString(string: "\(otters)獭 · \(convs)话", attributes: [
                    .font: NSFont.systemFont(ofSize: 10),
                    .foregroundColor: NSColor.white.withAlphaComponent(0.75),
                ])
                let s = label.size()
                if textX2 + s.width < x + w {
                    label.draw(at: NSPoint(x: textX2, y: midY - s.height / 2))
                }
            }
        case .sleeping:
            let label = NSAttributedString(string: "睡了", attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.white.withAlphaComponent(0.45),
            ])
            let s = label.size()
            label.draw(at: NSPoint(x: cursorX, y: midY - s.height / 2))
        case .offline:
            let label = NSAttributedString(string: "失联", attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: cGray,
            ])
            let s = label.size()
            label.draw(at: NSPoint(x: cursorX, y: midY - s.height / 2))
        }
    }

    // 非主胶囊：琥珀描边圆角矩形 + 9.5pt 琥珀字
    private func drawNonPrimaryPill(x: CGFloat, y: CGFloat) {
        let pill = NSBezierPath(roundedRect: NSRect(x: x, y: y - 8, width: 28, height: 16),
                                xRadius: 8, yRadius: 8)
        cAmber.setStroke()
        pill.lineWidth = 1
        pill.stroke()
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: CGFloat(9.5)),
            .foregroundColor: cAmber,
        ]
        let text = NSAttributedString(string: "非主", attributes: attrs)
        let sw = text.size().width
        let sh = text.size().height
        let px = x + (28 - sw) / 2
        text.draw(at: NSPoint(x: px, y: y - sh / 2))
    }
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

    /// 徽章 view 独占 item（搭档验收 22:24：系统原生控制条仍在 bar 上，
    /// 不再集成 esc/音量按钮；bar 布局留给美化迭代扩展）
    private func buildStack() -> NSView {
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 0
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 2, bottom: 0, right: 2)

        otterView.translatesAutoresizingMaskIntoConstraints = false
        stack.addView(otterView, in: .leading)
        return stack
    }

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
        // 边界态（检视獭-Swift2 建议 1）：top 空 / waiting 字段 nil / otters=0
        expect("mixedEmptyTop", deriveState(model(w: 2, top: "", c: 3, o: 2)),
               StatusRender(kind: .mixed(count: 2, top: "", convs: 3, otters: 2), nonPrimary: false))
        expect("waitingNilTop", deriveState(DisplayModel(v: 1, sys_online: true, offline_long: false,
               primary: "true", waiting: nil, working: nil)),
               StatusRender(kind: .sleeping, nonPrimary: false))
        expect("workingZeroOtters", deriveState(model(c: 2, o: 0)),
               StatusRender(kind: .working(convs: 2, otters: 0), nonPrimary: false))
        print(failed == 0 ? "SELFTEST PASS" : "SELFTEST FAIL (\(failed))")
        return failed == 0 ? 0 : 1
    }
}


// MARK: - Demo 渲染（--render-demo <outdir>：离屏产出六态动画帧序列，不碰 Touch Bar）
// 用途：README 等物料生产——渲染器自己的代码画的效果图，所见即生产所得。
// 每态 2.4s @ 12fps = 29 帧，PNG 序列输出，ffmpeg 合 GIF（特性文档「验证」节）。

enum DemoRenderer {
    static let scenes: [(String, StatusRender)] = [
        ("waiting", StatusRender(kind: .waiting(count: 3, top: "好idea蒸馏"), nonPrimary: false)),
        ("working", StatusRender(kind: .working(convs: 4, otters: 4), nonPrimary: false)),
        ("sleeping", StatusRender(kind: .sleeping, nonPrimary: false)),
        ("mixed", StatusRender(kind: .mixed(count: 3, top: "好idea蒸馏", convs: 2, otters: 2), nonPrimary: false)),
        ("offline", StatusRender(kind: .offline, nonPrimary: false)),
        ("nonprimary", StatusRender(kind: .working(convs: 2, otters: 2), nonPrimary: true)),
    ]

    static func run(outDir: String) -> Int32 {
        let fps = 12.0
        let seconds = 2.4
        let frames = Int(fps * seconds)
        let canvasW = 560.0
        let canvasH = 60.0

        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        let view = OtterView(frame: NSRect(x: 0, y: 0, width: 160, height: 30))
        view.frame.origin = NSPoint(x: 10, y: 15)

        for (si, scene) in scenes.enumerated() {
            view.update(scene.1)
            // 眨眼相位错开每态起始（纯视觉，无功能影响）
            for f in 0..<frames {
                let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(canvasW),
                                           pixelsHigh: Int(canvasH), bitsPerSample: 8,
                                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return 1 }
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = ctx
                // 纯黑 bar 底
                NSColor.black.setFill()
                NSBezierPath(rect: NSRect(x: 0, y: 0, width: canvasW, height: canvasH)).fill()
                // 徽章（渲染器本体）
                view.draw(view.bounds)
                // 右侧系统控制条（真实 bar 的原生区，demo 中还原观感）
                drawSystemStrip(x: 336, y: 15)
                NSGraphicsContext.restoreGraphicsState()

                guard let png = rep.representation(using: .png, properties: [:]) else { return 1 }
                let path = outDir + "/sc\(si)_" + String(format: "%03d", f) + ".png"
                try! png.write(to: URL(fileURLWithPath: path))
                view.tick(1.0 / fps)
            }
        }
        print("DEMO PASS: \(scenes.count) scenes x \(frames) frames -> \(outDir)")
        return 0
    }

    /// 右侧系统控制条（esc + 亮度 + 音量，模拟 bar 原生区观感；仅 demo 物料用）
    private static func drawSystemStrip(x: CGFloat, y: CGFloat) {
        func tintedSymbol(_ name: String) -> NSImage? {
            guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
            let out = NSImage(size: img.size)
            out.lockFocus()
            img.draw(in: NSRect(origin: .zero, size: img.size))
            NSColor.white.withAlphaComponent(0.55).setFill()
            NSRect(origin: .zero, size: img.size).fill(using: .sourceAtop)
            out.unlockFocus()
            return out
        }
        let esc = NSAttributedString(string: "esc", attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .medium),
            .foregroundColor: NSColor.white.withAlphaComponent(0.55),
        ])
        esc.draw(at: NSPoint(x: x, y: y + 6))
        var sx = x + 52
        for sym in ["sun.min", "sun.max", "speaker.wave.1", "speaker.wave.3"] {
            if let img = tintedSymbol(sym) {
                let r = NSRect(x: sx, y: y + 5, width: 20, height: 20)
                img.draw(in: r)
            }
            sx += 44
        }
    }
}

// MARK: - main

var args = CommandLine.arguments
if args.contains("--selftest") { exit(Selftest.run()) }
if let i = args.firstIndex(of: "--render-demo"), i + 1 < args.count {
    exit(DemoRenderer.run(outDir: args[i + 1]))
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
