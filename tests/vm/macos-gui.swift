// Native guest-only input, clipboard, window inventory and OCR. Never run on the Mac host.
import AppKit
import ApplicationServices
import Carbon
import Metal
import ScreenCaptureKit
import Vision

func output(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
let args = CommandLine.arguments
guard ProcessInfo.processInfo.environment["SN_VM_TEST"] == "1" else { exit(2) }

// Fail closed: input, window actions and capture act only on the driver-verified window.
// The driver revalidates process birth/argv/ancestry and exports these before each command.
let boundCommands: Set<String> = ["activate", "close", "click", "type", "key", "ocr-window"]
let windowTitle = "Standard Notes Agent Connection"
func onScreenWindows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}
func windowNumber(_ window: [String: Any]) -> Int? { (window[kCGWindowNumber as String] as? NSNumber)?.intValue }
func windowOwner(_ window: [String: Any]) -> Int? { (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue }
func bounds(_ window: [String: Any]) -> CGRect? {
    guard let dictionary = window[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: dictionary)
}
var boundPID = -1
var boundWindow = -1
if boundCommands.contains(args[1]) {
    let environment = ProcessInfo.processInfo.environment
    guard let pid = Int(environment["SN_GUI_BOUND_PID"] ?? ""), pid > 1,
          let number = Int(environment["SN_GUI_BOUND_WINDOW"] ?? ""), number > 0 else { exit(5) }
    let matches = onScreenWindows().filter {
        windowNumber($0) == number && windowOwner($0) == pid
            && $0[kCGWindowName as String] as? String == windowTitle
            && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
    }
    guard matches.count == 1 else { exit(5) }
    boundPID = pid
    boundWindow = number
    if ["activate", "close"].contains(args[1]) { guard Int(args[2]) == pid else { exit(5) } }
    if args[1] == "ocr-window" { guard Int(args[2]) == number else { exit(5) } }
    if ["type", "key"].contains(args[1]) {
        // Synthetic keys go to whichever app is focused; refuse unless it is the bound process.
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == Int32(pid) else { exit(5) }
    }
    if args[1] == "click" {
        // The topmost window under the point must be the bound window (front-to-back order).
        let point = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
        guard let top = onScreenWindows().first(where: { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 && bounds($0)?.contains(point) == true }),
              windowNumber(top) == number else { exit(5) }
    }
}
func captureBoundWindow() throws -> CGImage {
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var outcome: Result<CGImage, Error> = .failure(CocoaError(.fileReadUnknown))
    let id = CGWindowID(boundWindow)
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == Int32(boundPID) }) else {
                throw CocoaError(.fileNoSuchFile)
            }
            let configuration = SCStreamConfiguration()
            configuration.width = Int(window.frame.width) * 2
            configuration.height = Int(window.frame.height) * 2
            configuration.showsCursor = false
            outcome = .success(try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration))
        } catch { outcome = .failure(error) }
        done.signal()
    }
    done.wait()
    return try outcome.get()
}
func recognizedWords(_ perform: (VNRecognizeTextRequest) throws -> Void) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    try perform(request)
    let tokens = try NSRegularExpression(pattern: "\\S+")
    var words: [[String: Any]] = []
    for result in request.results ?? [] {
        guard let candidate = result.topCandidates(1).first else { continue }
        let text = candidate.string
        for match in tokens.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range, in: text), let box = try candidate.boundingBox(for: range) else { continue }
            let rect = box.boundingBox
            words.append(["text": String(text[range]), "x": rect.midX, "y": 1 - rect.midY])
        }
    }
    return words
}
switch args[1] {
case "preflight":
    try output([
        "accessibility": AXIsProcessTrusted(),
        "postEvents": CGPreflightPostEventAccess(),
        "screenCapture": CGPreflightScreenCaptureAccess(),
        "metal": MTLCreateSystemDefaultDevice()?.name ?? "unavailable",
        "displays": NSScreen.screens.count,
        "screenWidth": NSScreen.main?.frame.width ?? 0,
        "screenHeight": NSScreen.main?.frame.height ?? 0
    ])
case "allow-guest-capture":
    // Standard disposable-guest OS consent only; never edit TCC or click unrelated dialogs.
    guard let token = ProcessInfo.processInfo.environment["SN_MAC_TOKEN"],
          (try? String(contentsOfFile: "/tmp/sn-acceptance-\(token)/owner", encoding: .utf8)) == token else { exit(2) }
    guard let front = NSWorkspace.shared.frontmostApplication, front.localizedName == "UserNotificationCenter" else {
        try output(["allowed": false]); exit(0)
    }
    var strings: [String] = []
    var buttons: [AXUIElement] = []
    func inspect(_ element: AXUIElement, _ depth: Int) {
        guard depth < 16 else { return }
        for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value = value as? String {
                strings.append(value)
                if value == "Allow" { buttons.append(element) }
            }
        }
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success {
            for child in children as? [AXUIElement] ?? [] { inspect(child, depth + 1) }
        }
    }
    inspect(AXUIElementCreateApplication(front.processIdentifier), 0)
    let text = strings.joined(separator: " ")
    guard text.contains("com.apple.sshd-session"), text.contains("private window picker"), text.contains("screen and audio"), let allow = buttons.first else {
        try output(["allowed": false, "unexpectedDialog": true]); exit(0)
    }
    guard AXUIElementPerformAction(allow, kAXPressAction as CFString) == .success else { exit(4) }
    try output(["allowed": true])
case "frontmost":
    let app = NSWorkspace.shared.frontmostApplication
    try output(["pid": app?.processIdentifier ?? -1, "name": app?.localizedName ?? "unknown"])
case "windows":
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    try output(info)
case "activate":
    guard let app = NSRunningApplication(processIdentifier: Int32(args[2])!) else { exit(1) }
    app.activate(options: [])
case "close":
    let app = AXUIElementCreateApplication(Int32(args[2])!)
    var windows: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows) == .success,
          let window = (windows as? [AXUIElement])?.first else { exit(4) }
    var button: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXCloseButtonAttribute as CFString, &button) == .success,
          let button else { exit(4) }
    guard AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else { exit(4) }
case "click":
    let point = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
    for kind in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        let event = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: point, mouseButton: .left)!
        event.flags = []
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        event.post(tap: .cghidEventTap)
        // GPUI's hitbox hover state is refreshed on a frame before down/up dispatch.
        Thread.sleep(forTimeInterval: 0.12)
    }
case "type":
    let value = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    // GPUI resolves key characters through the active hardware layout, not batched Unicode events.
    // The VM fixture uses the base image's US/ABC layout and synthetic ASCII credentials only.
    let codes: [String: Int] = [
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D,
        "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H,
        "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
        "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P,
        "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
        "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
        "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "1": kVK_ANSI_1, "2": kVK_ANSI_2,
        "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6,
        "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9, "0": kVK_ANSI_0,
        "-": kVK_ANSI_Minus, ".": kVK_ANSI_Period, " ": kVK_Space,
        "\\": kVK_ANSI_Backslash
    ]
    for character in value {
        let text = String(character)
        let base = text == "@" ? "2" : text == "|" ? "\\" : text.lowercased()
        guard let code = codes[base] else { exit(3) }
        let shift = text != base
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down)!
            event.flags = shift ? .maskShift : []
            event.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.04)
        }
    }
case "key":
    let code = CGKeyCode(args[2])!
    let command = args.count > 3 && args[3] == "command"
    func sendKey(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags) {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
        event.flags = flags
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.10)
    }
    if command { sendKey(CGKeyCode(kVK_Command), true, .maskCommand) }
    sendKey(code, true, command ? .maskCommand : [])
    sendKey(code, false, command ? .maskCommand : [])
    if command { sendKey(CGKeyCode(kVK_Command), false, []) }
case "clipboard-count":
    print(NSPasteboard.general.changeCount)
case "clipboard-read":
    FileHandle.standardOutput.write(Data((NSPasteboard.general.string(forType: .string) ?? "").utf8))
case "clipboard-write":
    let text = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
case "ocr":
    let imageURL = URL(fileURLWithPath: args[2])
    try output(try recognizedWords { try VNImageRequestHandler(url: imageURL).perform([$0]) })
case "ocr-window":
    // ScreenCaptureKit CGImage -> Vision -> stdout. No pixels, text or credentials touch disk.
    let image = try captureBoundWindow()
    try output(try recognizedWords { try VNImageRequestHandler(cgImage: image).perform([$0]) })
default:
    exit(2)
}
