// quiznative —— 屏幕共享答题助手自带原生能力（零第三方依赖）
//
// 子命令：
//   quiznative perms
//   quiznative windows
//   quiznative ocr <png> <winX> <winY> <winW> <winH>
//   quiznative click <x> <y> [count]
//   quiznative move <x> <y>
//   quiznative activate <windowId>
//
// 坐标约定：全部是**逻辑 point**，全局屏幕坐标系，原点在主屏左上角。
// Vision 返回的 boundingBox 是以图片左下角为原点的归一化坐标，这里统一换算成
// 「窗口内逻辑坐标 → 全局逻辑坐标」；图片像素分辨率只在换算比例时使用。

import Foundation
import Vision
import CoreGraphics
import ImageIO
import AppKit
import ApplicationServices

func die(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func emit(_ object: Any) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
        die("无法序列化输出")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func doubleArg(_ args: [String], _ index: Int, _ name: String) -> Double {
    guard args.count > index, let value = Double(args[index]) else {
        die("缺少或非法参数 \(name)")
    }
    return value
}

// MARK: - 权限

func commandPerms() {
    let screen = CGPreflightScreenCaptureAccess()
    let ax = AXIsProcessTrusted()
    emit([
        "screenCapture": screen,
        "accessibility": ax,
        "screenCapturePromptURL": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "accessibilityPromptURL": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    ])
}

// MARK: - 窗口枚举

func commandWindows() {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        emit([])
        return
    }
    var windows: [[String: Any]] = []
    for entry in raw {
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        guard layer == 0 else { continue }
        guard let number = entry[kCGWindowNumber as String] as? Int else { continue }
        guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
        guard rect.width > 40, rect.height > 40 else { continue }
        windows.append([
            "windowId": number,
            "pid": entry[kCGWindowOwnerPID as String] as? Int ?? 0,
            "sharing": entry[kCGWindowSharingState as String] as? Int ?? 0,
            "owner": entry[kCGWindowOwnerName as String] as? String ?? "",
            "title": entry[kCGWindowName as String] as? String ?? "",
            "x": Double(rect.origin.x),
            "y": Double(rect.origin.y),
            "width": Double(rect.size.width),
            "height": Double(rect.size.height),
        ])
    }
    emit(windows)
}

// MARK: - OCR（Apple Vision）

func commandOCR(_ args: [String]) {
    guard args.count >= 6 else { die("用法: ocr <png> <winX> <winY> <winW> <winH>") }
    let path = args[1]
    let winX = doubleArg(args, 2, "winX")
    let winY = doubleArg(args, 3, "winY")
    let winW = doubleArg(args, 4, "winW")
    let winH = doubleArg(args, 5, "winH")
    guard winW > 1, winH > 1 else { die("窗口尺寸非法") }

    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        die("无法读取截图: \(path)")
    }
    let pixelWidth = Double(image.width)
    let pixelHeight = Double(image.height)
    guard pixelWidth > 1, pixelHeight > 1 else { die("截图尺寸非法") }
    // 截图是物理像素，窗口 bounds 是逻辑 point，两者比例可能是 2.0（Retina）或 1.0
    let scaleX = pixelWidth / winW
    let scaleY = pixelHeight / winH

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // 中文识别必须开启语言纠正：关闭后 Vision 对 zh-Hans 直接返回空结果（CRImageReaderError 9）。
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        die("Vision OCR 失败: \(error.localizedDescription)")
    }

    let observations = request.results ?? []
    var lines: [[String: Any]] = []
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox // 归一化，原点左下
        let x = winX + (Double(box.origin.x) * pixelWidth) / scaleX
        let topPixels = (1.0 - Double(box.origin.y) - Double(box.size.height)) * pixelHeight
        let y = winY + topPixels / scaleY
        let width = (Double(box.size.width) * pixelWidth) / scaleX
        let height = (Double(box.size.height) * pixelHeight) / scaleY
        lines.append([
            "text": candidate.string,
            "confidence": Double(candidate.confidence),
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "centerX": x + width / 2.0,
            "centerY": y + height / 2.0,
        ])
    }
    lines.sort { a, b in
        let ay = a["y"] as? Double ?? 0
        let by = b["y"] as? Double ?? 0
        if abs(ay - by) > 4 { return ay < by }
        return (a["x"] as? Double ?? 0) < (b["x"] as? Double ?? 0)
    }
    emit([
        "pixelWidth": pixelWidth,
        "pixelHeight": pixelHeight,
        "scaleX": scaleX,
        "scaleY": scaleY,
        "lines": lines,
    ])
}

// MARK: - 鼠标

func postMouse(_ type: CGEventType, _ point: CGPoint, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
        die("无法创建鼠标事件")
    }
    if type == .leftMouseDown || type == .leftMouseUp || type == .leftMouseDragged {
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
    }
    event.post(tap: .cghidEventTap)
}

func commandClick(_ args: [String]) {
    let x = doubleArg(args, 1, "x")
    let y = doubleArg(args, 2, "y")
    let count = args.count > 3 ? max(1, min(3, Int(doubleArg(args, 3, "count")))) : 1
    let point = CGPoint(x: x, y: y)
    // 先把光标挪过去，再按下去：某些 Web UI 依赖 mouseover/mousemove 才显示可点状态
    postMouse(.mouseMoved, point)
    usleep(15_000)
    for index in 1...count {
        postMouse(.leftMouseDown, point, clickState: Int64(index))
        usleep(25_000)
        postMouse(.leftMouseUp, point, clickState: Int64(index))
        usleep(45_000)
    }
    emit(["clicked": true, "x": x, "y": y, "count": count])
}

func postMouseToPid(_ type: CGEventType, _ point: CGPoint, pid: pid_t, windowId: Int = 0, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
        die("无法创建鼠标事件")
    }
    if type == .leftMouseDown || type == .leftMouseUp || type == .leftMouseDragged {
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
    }
    if windowId > 0 {
        // 让目标进程知道事件属于哪个窗口，Chromium/Electron 的命中测试依赖这个字段
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowId))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowId))
    }
    event.postToPid(pid)
}

/// 把点击注入目标进程：不移动系统光标，也不抢焦点，用户可继续用鼠标。
func commandClickInject(_ args: [String]) {
    let pidRaw = Int(doubleArg(args, 1, "pid"))
    guard pidRaw > 0, let app = NSRunningApplication(processIdentifier: pid_t(pidRaw)) else {
        die("无效的目标进程 pid")
    }
    let pid = pid_t(pidRaw)
    let x = doubleArg(args, 2, "x")
    let y = doubleArg(args, 3, "y")
    let count = args.count > 4 ? max(1, min(3, Int(doubleArg(args, 4, "count")))) : 1
    let windowId = args.count > 5 ? Int(doubleArg(args, 5, "windowId")) : 0
    let point = CGPoint(x: x, y: y)
    let mode = args.count > 6 ? args[6] : (ProcessInfo.processInfo.environment["QUIZ_CLICK_MODE"] ?? "auto")
    let appName = app.localizedName ?? ""
    let chromium = ["Microsoft Edge", "Google Chrome", "Brave Browser", "Chromium", "Vivaldi", "Arc", "Opera"].contains(appName)
    if mode == "ax" {
        var out = axPress(at: point, windowId: windowId)
        out["x"] = x
        out["y"] = y
        emit(out)
        return
    }
    if mode == "pointer" || (mode == "auto" && chromium) {
        // Chromium 会静默丢弃 postToPid 的合成事件（已实测），改走真实指针点击并立刻恢复光标位置
        pointerClickRestore(point, count: count)
        emit(["injected": false, "mechanism": "pointer-restored", "pid": pidRaw, "x": x, "y": y, "count": count, "app": appName])
        return
    }
    postMouseToPid(.mouseMoved, point, pid: pid, windowId: windowId)
    usleep(20_000)
    for index in 1...count {
        postMouseToPid(.leftMouseDown, point, pid: pid, windowId: windowId, clickState: Int64(index))
        usleep(25_000)
        postMouseToPid(.leftMouseUp, point, pid: pid, windowId: windowId, clickState: Int64(index))
        usleep(45_000)
    }
    emit(["injected": true, "pid": pidRaw, "windowId": windowId, "x": x, "y": y, "count": count, "app": app.localizedName ?? ""])
}

/// 用 Accessibility API 在坐标处按下元素：不移动光标，对 Chromium/原生控件都有效
func axPress(at point: CGPoint, windowId: Int) -> [String: Any] {
    // Chromium 默认不构建 Web 无障碍树；置 AXManualAccessibility 后才会暴露按钮等元素
    if let app = NSRunningApplication(processIdentifier: NSRunningApplication.current.processIdentifier) {
        _ = app
    }
    let system = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    let hit = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element)
    guard hit == .success, let el = element else {
        return ["ok": false, "reason": "AXCopyElementAtPosition failed: \(hit.rawValue)"]
    }
    var role: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role)
    let actionResult = AXUIElementPerformAction(el, kAXPressAction as CFString)
    return [
        "ok": actionResult == .success,
        "role": (role as? String) ?? "",
        "axError": Int(actionResult.rawValue),
        "windowId": windowId,
    ]
}

/// 真实指针点击：仅用于明确忽略 postToPid 事件的进程（Chromium 系浏览器）
func pointerClickRestore(_ point: CGPoint, count: Int) {
    let saved = CGEvent(source: nil)?.location ?? .zero
    CGAssociateMouseAndMouseCursorPosition(boolean_t(0))
    CGWarpMouseCursorPosition(point)
    usleep(30_000)
    for index in 1...count {
        postMouse(.mouseMoved, point)
        usleep(10_000)
        postMouse(.leftMouseDown, point, clickState: Int64(index))
        usleep(25_000)
        postMouse(.leftMouseUp, point, clickState: Int64(index))
        usleep(35_000)
    }
    CGWarpMouseCursorPosition(saved)
    CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
}

func commandCursor() {
    let loc = CGEvent(source: nil)?.location ?? .zero
    emit(["x": loc.x, "y": loc.y])
}

func commandMove(_ args: [String]) {
    let x = doubleArg(args, 1, "x")
    let y = doubleArg(args, 2, "y")
    postMouse(.mouseMoved, CGPoint(x: x, y: y))
    emit(["moved": true, "x": x, "y": y])
}

// MARK: - 激活窗口

func commandActivate(_ args: [String]) {
    let windowId = Int(doubleArg(args, 1, "windowId"))
    let options: CGWindowListOption = [.optionIncludingWindow]
    guard let raw = CGWindowListCopyWindowInfo(options, CGWindowID(windowId)) as? [[String: Any]],
          let entry = raw.first,
          let pid = entry[kCGWindowOwnerPID as String] as? Int else {
        die("找不到窗口 \(windowId)")
    }
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
        die("找不到窗口所属进程 \(pid)")
    }
    if #available(macOS 14.0, *) {
        app.activate()
    } else {
        app.activate(options: [.activateIgnoringOtherApps])
    }
    emit(["activated": true, "windowId": windowId, "pid": pid])
}

// MARK: - 徽标检测（按颜色找 A/B/C/D 圆圈，不依赖 OCR）

func commandBadges(_ args: [String]) {
    guard args.count >= 6 else { die("用法: badges <png> <winX> <winY> <winW> <winH>") }
    let path = args[1]
    let winX = doubleArg(args, 2, "winX")
    let winY = doubleArg(args, 3, "winY")
    let winW = doubleArg(args, 4, "winW")
    let winH = doubleArg(args, 5, "winH")
    guard winW > 1, winH > 1 else { die("窗口尺寸非法") }

    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        die("无法读取截图: \(path)")
    }
    let pw = image.width
    let ph = image.height
    let scaleX = Double(pw) / winW
    let scaleY = Double(ph) / winH

    var pixels = [UInt8](repeating: 0, count: pw * ph * 4)
    guard let ctx = CGContext(data: &pixels, width: pw, height: ph, bitsPerComponent: 8,
                              bytesPerRow: pw * 4, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        die("无法创建位图上下文")
    }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: pw, height: ph))

    // 选项徽标是圆环状的品牌蓝（实测 ~RGB(0,160,251)）；文字同色但只在徽标右侧。
    // 先按颜色取全部蓝像素，再找左侧出现最多的那一列（徽标列），最后按行分段找出每个圆。
    func isBadgeBlue(_ i: Int) -> Bool {
        let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
        return b > 195 && g > 120 && g < 240 && r < 190 && b - r > 40 && b - g > 20
    }

    var colHist = [Int](repeating: 0, count: pw)
    var blueCount = 0
    for y in 0..<ph {
        let base = y * pw
        for x in 0..<pw {
            if isBadgeBlue((base + x) * 4) {
                colHist[x] += 1
                blueCount += 1
            }
        }
    }
    guard blueCount > 50 else {
        emit(["count": 0, "badges": [Any]()])
        return
    }
    // 徽标列：在左侧 45% 宽度里取蓝像素最多的列
    var colX = 0
    var best = -1
    let limitX = max(1, Int(Double(pw) * 0.45))
    for x in 0..<limitX where colHist[x] > best {
        best = colHist[x]
        colX = x
    }
    let bandHalf = Int(Double(pw) * 0.09)

    var rowBlue = [Int](repeating: 0, count: ph)
    var rowSumX = [Int](repeating: 0, count: ph)
    for y in 0..<ph {
        let base = y * pw
        let lo = max(0, colX - bandHalf)
        let hi = min(pw - 1, colX + bandHalf)
        for x in lo...hi where isBadgeBlue((base + x) * 4) {
            rowBlue[y] += 1
            rowSumX[y] += x
        }
    }

    var bands: [(y0: Int, y1: Int, sumX: Int, count: Int)] = []
    var current: (y0: Int, y1: Int, sumX: Int, count: Int)? = nil
    for y in 0..<ph {
        if rowBlue[y] >= 2 {
            if var cur = current {
                cur.y1 = y
                cur.sumX += rowSumX[y]
                cur.count += rowBlue[y]
                current = cur
            } else {
                current = (y, y, rowSumX[y], rowBlue[y])
            }
        } else if let cur = current {
            bands.append(cur)
            current = nil
        }
    }
    if let cur = current { bands.append(cur) }

    var badges: [[String: Any]] = []
    for band in bands {
        let hPix = band.y1 - band.y0 + 1
        let hLogical = Double(hPix) / scaleY
        // 徽标圆圈直径约 20~32 物理像素（10~16 逻辑点）；选中态是实心圆，行内像素更密，不能按密度筛
        guard hLogical >= 8, hLogical <= 34 else { continue }
        guard band.count > 8 else { continue }
        let cy = (Double(band.y0 + band.y1) / 2) / scaleY + winY
        let cx = (Double(band.sumX) / Double(band.count)) / scaleX + winX
        badges.append([
            "x": (cx * 10).rounded() / 10,
            "y": (cy * 10).rounded() / 10,
            "h": (Double(hPix) / scaleY * 10).rounded() / 10,
        ])
    }
    emit(["count": badges.count, "badges": badges])
}

// MARK: - 入口

let args = Array(CommandLine.arguments.dropFirst())
guard let subcommand = args.first else { die("用法: quiznative <perms|windows|ocr|badges|click|clickpid|move|cursor|activate> ...") }
switch subcommand {
case "perms": commandPerms()
case "windows": commandWindows()
case "ocr": commandOCR(args)
case "badges": commandBadges(args)
case "click": commandClick(args)
case "clickpid": commandClickInject(args)
case "move": commandMove(args)
case "cursor": commandCursor()
case "activate": commandActivate(args)
default: die("未知子命令: \(subcommand)")
}
