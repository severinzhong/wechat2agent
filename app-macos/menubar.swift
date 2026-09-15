import AppKit

// wechat2agent 菜单栏面板
// 构建: app-macos/build.sh（产出 dist/WeChat2Agent.app）
// 开发期直接跑: swiftc -O app-macos/menubar.swift -o /tmp/panel && /tmp/panel
//   （非 bundle 模式下面板从 ~/.wechat2agent/gateway-home 读项目路径，用 npm start 启动）

let STORAGE_DIR = NSHomeDirectory() + "/.wechat2agent"
let GATEWAY_HOME_FILE = STORAGE_DIR + "/gateway-home"
let LOCK_FILE = STORAGE_DIR + "/gateway.lock"
let PORT_FILE = STORAGE_DIR + "/gateway.port"
let LOG_FILE = STORAGE_DIR + "/gateway.log"

struct GatewayStatus: Decodable {
  let ok: Bool
  let accountId: String?
  let uptimeSec: Int
  let peers: [Peer]
  struct Peer: Decodable {
    let peer: String
    let backend: String
    let model: String?
    let variant: String?
    let workdir: String?
    let taskActive: Bool
  }
}

final class PanelApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var statusItem: NSStatusItem!
  private var timer: Timer?
  private var status: GatewayStatus?

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    menu.delegate = self
    statusItem.menu = menu
    refreshIcon()
    refreshStatus()
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.refreshStatus()
    }
  }

  // MARK: - 状态获取

  private func refreshStatus() {
    guard let port = try? String(contentsOfFile: PORT_FILE, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
          !port.isEmpty,
          let url = URL(string: "http://127.0.0.1:\(port)/status") else {
      status = nil
      refreshIcon()
      return
    }
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let self else { return }
      let decoded = data.flatMap { try? JSONDecoder().decode(GatewayStatus.self, from: $0) }
      DispatchQueue.main.async {
        self.status = decoded
        self.refreshIcon()
      }
    }.resume()
  }

  private func refreshIcon() {
    let running = status?.ok == true
    let name = running ? "bolt.horizontal.fill" : "bolt.horizontal"
    if let img = NSImage(systemSymbolName: name, accessibilityDescription: "wechat2agent") {
      statusItem.button?.image = img
    } else {
      statusItem.button?.title = running ? "⚡︎" : "○"
    }
  }

  // MARK: - 菜单

  func menuWillOpen(_ menu: NSMenu) {
    menu.removeAllItems()
    if let s = status, s.ok {
      let mins = s.uptimeSec / 60
      menu.addItem(.init(title: "运行中 · \(s.accountId ?? "?") · \(mins) 分钟", action: nil, keyEquivalent: ""))
      menu.addItem(.separator())
      for p in s.peers {
        let task = p.taskActive ? " · 任务运行中" : ""
        let line = "\(p.backend)\(p.model.map { "/\($0)" } ?? "")\(p.variant.map { " · \($0)" } ?? "")\(task)"
        menu.addItem(.init(title: line, action: nil, keyEquivalent: ""))
        if let w = p.workdir {
          let item = NSMenuItem(title: "  \(w)", action: #selector(revealWorkdir(_:)), keyEquivalent: "")
          item.representedObject = w
          item.target = self
          menu.addItem(item)
        }
      }
      menu.addItem(.separator())
      addItem(menu, "停止 Gateway", #selector(stopGateway))
    } else {
      menu.addItem(.init(title: "未运行", action: nil, keyEquivalent: ""))
      menu.addItem(.separator())
      addItem(menu, "启动 Gateway", #selector(startGateway))
    }
    addItem(menu, "查看日志", #selector(openLog))
    menu.addItem(.separator())
    addItem(menu, "退出面板", #selector(quit))
  }

  private func addItem(_ menu: NSMenu, _ title: String, _ action: Selector) {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = self
    menu.addItem(item)
  }

  // MARK: - 操作

  /// 启动命令：优先 app bundle 内嵌的 node + gateway.mjs；
  /// 开发模式（loose binary）读 ~/.wechat2agent/gateway-home 指向的项目目录，用 npm start。
  @objc private func startGateway() {
    if let res = Bundle.main.resourceURL {
      let node = res.appendingPathComponent("node").path
      let script = res.appendingPathComponent("gateway.mjs").path
      if FileManager.default.fileExists(atPath: node), FileManager.default.fileExists(atPath: script) {
        let p = Process()
        // 经 login shell 启动以继承用户 PATH（codex/zl 在 nvm/homebrew 等位置）
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "'\(node)' '\(script)'"]
        try? p.run()
        return
      }
    }
    // 开发模式
    if let home = try? String(contentsOfFile: GATEWAY_HOME_FILE, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
       !home.isEmpty {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/zsh")
      p.arguments = ["-lc", "cd '\(home)' && npm start"]
      try? p.run()
      return
    }
    // 找不到 gateway：写日志提示
    let msg = "[\(Date())] 无法启动：未找到内嵌 gateway，也未配置 \(GATEWAY_HOME_FILE)\n"
    if let data = msg.data(using: .utf8) {
      if FileManager.default.fileExists(atPath: LOG_FILE),
         let h = FileHandle(forWritingAtPath: LOG_FILE) {
        h.seekToEndOfFile(); h.write(data); try? h.close()
      } else {
        FileManager.default.createFile(atPath: LOG_FILE, contents: data)
      }
    }
  }

  @objc private func stopGateway() {
    guard let pidStr = try? String(contentsOfFile: LOCK_FILE, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
          let pid = Int32(pidStr) else { return }
    kill(pid, SIGTERM)
  }

  @objc private func openLog() {
    // 文件可能不存在（gateway 尚未写过日志）：先创建再打开
    if !FileManager.default.fileExists(atPath: LOG_FILE) {
      FileManager.default.createFile(atPath: LOG_FILE, contents: Data())
    }
    NSWorkspace.shared.open(URL(fileURLWithPath: LOG_FILE))
  }

  @objc private func revealWorkdir(_ sender: NSMenuItem) {
    guard let dir = sender.representedObject as? String else { return }
    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: dir)
  }

  @objc private func quit() {
    NSApplication.shared.terminate(nil)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = PanelApp()
app.delegate = delegate
app.run()
