import AppKit
import WebKit

// Usage: harness <sandbox flags>. Loads a parent page with a sandboxed srcdoc iframe, clicks the link with a real NSEvent, and logs what happens.
let flags = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "allow-same-origin"
let page = """
<!doctype html><html><body style="margin:0"><div id=p style="height:40px;background:#eee">PARENT</div>
<iframe id=f sandbox="\(flags)" style="width:400px;height:200px;border:0"
 srcdoc="<a id=l href='https://example.com/x' style='display:block;font-size:40px'>LINK</a>"></iframe>
<script>
const f = document.getElementById('f');
document.addEventListener('mousedown', (e) => webkit.messageHandlers.log.postMessage('parent mousedown at ' + e.clientX + ',' + e.clientY + ' on ' + e.target.id), true);
f.onload = () => {
  const doc = f.contentDocument;
  doc.addEventListener('click', () => webkit.messageHandlers.log.postMessage('listener fired'), true);
  const a = doc.getElementById('l');
  a.setAttribute('target', '_top');
  const r = a.getBoundingClientRect(), fr = f.getBoundingClientRect();
  webkit.messageHandlers.ready.postMessage([fr.left + r.left + 10, fr.top + r.top + 10]);
};
</script></body></html>
"""

final class D: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
  var web: WKWebView!
  var window: NSWindow!
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let url = a.request.url?.absoluteString ?? ""
    print("navigation: \(url) main=\(a.targetFrame?.isMainFrame ?? false) user=\(a.navigationType == .linkActivated)")
    decisionHandler(url.hasPrefix("https://example.com") ? .cancel : .allow)
  }
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    if m.name == "log" { print(m.body); return }
    let p = m.body as! [Double]
    let pt = web.isFlipped ? NSPoint(x: p[0], y: p[1]) : NSPoint(x: p[0], y: Double(web.frame.height) - p[1])
    print("flipped=\(web.isFlipped) target=\(p)")
    window.makeKey()
    for kind in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      let e = NSEvent.mouseEvent(with: kind, location: web.convert(pt, to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
      let wp = web.convert(pt, to: nil)
      let hit = window.contentView!.hitTest(wp)
      if kind == .leftMouseDown { print("hit=\(String(describing: hit.map { type(of: $0) }))") }
      if kind == .leftMouseDown { hit?.mouseDown(with: e) } else { hit?.mouseUp(with: e) }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { exit(0) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let d = D()
let cfg = WKWebViewConfiguration()
cfg.userContentController.add(d, name: "log")
cfg.userContentController.add(d, name: "ready")
d.window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
d.web = WKWebView(frame: d.window.contentView!.bounds, configuration: cfg)
d.web.navigationDelegate = d
d.window.contentView!.addSubview(d.web)
d.window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
d.web.loadHTMLString(page, baseURL: URL(string: "http://localhost/")!)
DispatchQueue.main.asyncAfter(deadline: .now() + 8) { print("timeout"); exit(1) }
app.run()
