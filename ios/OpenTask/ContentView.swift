import SwiftUI

/// Main content view — hosts the WKWebView that loads the OpenTask PWA.
struct ContentView: View {
    let config = AppConfig.shared

    var body: some View {
        if let url = URL(string: config.serverURL) {
            WebView(url: url)
                .ignoresSafeArea()
        } else {
            Text("Invalid server URL")
                .foregroundStyle(.secondary)
        }
    }
}
