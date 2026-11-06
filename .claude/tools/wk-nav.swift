import AppKit
import WebKit

// Does a mail body make the delegate see an external URL without a click? Parent and body CSP as in the app.
let body = CommandLine.arguments[1]
let bodyCsp = #"<meta http-equiv='Content-Security-Policy' content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">"#
let srcdoc = (bodyCsp + body).replacingOccurrences(of: "\"", with: "&quot;")
let page = """
<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'"></head><body>
<iframe sandbox="allow-same-origin allow-top-navigation-by-user-activation" srcdoc="\(srcdoc)"></iframe></body></html>
"""
final class D: NSObject, WKNavigationDelegate {
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    print("navigation: \(a.request.url?.absoluteString ?? "") main=\(a.targetFrame?.isMainFrame ?? false)")
    decisionHandler(.allow)
  }
}
let app = NSApplication.shared
let d = D()
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
web.navigationDelegate = d
web.loadHTMLString(page, baseURL: URL(string: "http://localhost/")!)
DispatchQueue.main.asyncAfter(deadline: .now() + 4) { exit(0) }
app.run()
