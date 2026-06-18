import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var webView: WKWebView!
    private var nodeProcess: Process?
    private var outputBuffer = ""

    func applicationDidFinishLaunching(_: Notification) {
        setupStatusItem()
        setupPopover()
        launchBridge()
    }

    // MARK: - Status item

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        guard let button = statusItem.button else { return }
        let img = NSImage(systemSymbolName: "slider.horizontal.3",
                          accessibilityDescription: "Waterbird Bridge")
        img?.isTemplate = true
        button.image = img
        button.action = #selector(handleClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.target = self
    }

    @objc private func handleClick(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }
        if event.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(NSMenuItem(title: "Quit Waterbird Bridge",
                                    action: #selector(NSApp.terminate(_:)),
                                    keyEquivalent: "q"))
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else {
            togglePopover(sender)
        }
    }

    // MARK: - Popover

    private func setupPopover() {
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 500, height: 620),
                            configuration: config)
        webView.autoresizingMask = [.width, .height]

        let vc = NSViewController()
        vc.view = webView

        popover = NSPopover()
        popover.contentSize = NSSize(width: 500, height: 620)
        popover.contentViewController = vc
        popover.behavior = .transient

        webView.loadHTMLString(placeholderHTML("Starting Waterbird Bridge\u{2026}"), baseURL: nil)
    }

    @objc private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: - Bridge process

    private func launchBridge() {
        guard let resourcePath = Bundle.main.resourcePath else { return }
        let binaryPath = (resourcePath as NSString).appendingPathComponent("waterbird-bridge")

        guard FileManager.default.isExecutableFile(atPath: binaryPath) else {
            showPlaceholder("Bridge binary not found in app bundle.")
            return
        }

        // Config file lives in ~/Library/Application Support/Waterbird Bridge/
        let workDir: URL
        if let appSupport = FileManager.default
                .urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            workDir = appSupport.appendingPathComponent("Waterbird Bridge")
            try? FileManager.default.createDirectory(at: workDir,
                                                     withIntermediateDirectories: true)
        } else {
            workDir = URL(fileURLWithPath: NSHomeDirectory())
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binaryPath)
        process.currentDirectoryURL = workDir
        nodeProcess = process

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self, !data.isEmpty,
                  let text = String(data: data, encoding: .utf8) else { return }
            self.processOutput(text)
        }

        do {
            try process.run()
        } catch {
            showPlaceholder("Failed to start bridge: \(error.localizedDescription)")
        }
    }

    // Parse stdout lines looking for "Web config    http://localhost:PORT"
    private func processOutput(_ text: String) {
        outputBuffer += text
        var lines = outputBuffer.components(separatedBy: "\n")
        outputBuffer = lines.removeLast()
        for line in lines {
            guard line.contains("Web config"),
                  let range = line.range(of: #"http://localhost:\d+"#,
                                         options: .regularExpression),
                  let url = URL(string: String(line[range])) else { continue }
            DispatchQueue.main.async { [weak self] in
                self?.webView.load(URLRequest(url: url))
            }
        }
    }

    private func showPlaceholder(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView.loadHTMLString(self?.placeholderHTML(message) ?? "", baseURL: nil)
        }
    }

    func applicationWillTerminate(_: Notification) {
        nodeProcess?.terminate()
    }

    // MARK: - Placeholder HTML

    private func placeholderHTML(_ message: String) -> String {
        """
        <!DOCTYPE html><html>
        <body style="background:#111;color:#888;font-family:system-ui;
          display:flex;align-items:center;justify-content:center;
          height:100vh;margin:0;font-size:.9rem">\(message)</body></html>
        """
    }
}

// Entry point
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
