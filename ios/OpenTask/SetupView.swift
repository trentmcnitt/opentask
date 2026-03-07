import SwiftUI

/// First-launch setup: server URL entry.
///
/// Validates by checking the server is reachable. On success, stores the URL
/// in Keychain and transitions to the main WebView where the user logs in
/// and a Bearer token is auto-provisioned for notification actions.
struct SetupView: View {
    @State private var serverURL = ""
    @State private var isValidating = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Enter your OpenTask server URL to enable push notifications with snooze actions.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Section("Server") {
                    TextField("https://tasks.example.com", text: $serverURL)
                        .textContentType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .keyboardType(.URL)
                }

                if let error = errorMessage {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.subheadline)
                    }
                }

                Section {
                    Button {
                        Task { await validate() }
                    } label: {
                        HStack {
                            Text("Connect")
                            Spacer()
                            if isValidating {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(!canSubmit)
                }
            }
            .navigationTitle("OpenTask Setup")
        }
    }

    private var canSubmit: Bool {
        !serverURL.isEmpty && !isValidating
    }

    private func validate() async {
        isValidating = true
        errorMessage = nil

        // Normalize URL: strip trailing slash
        var url = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") {
            url.removeLast()
        }

        // Verify the server is reachable by loading the login page
        guard let checkURL = URL(string: "\(url)/login") else {
            errorMessage = "Invalid URL"
            isValidating = false
            return
        }

        do {
            var request = URLRequest(url: checkURL)
            request.timeoutInterval = 10
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, (200...399).contains(http.statusCode) {
                AppConfig.shared.configure(serverURL: url)
            } else {
                errorMessage = "Server not reachable (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0))"
            }
        } catch {
            errorMessage = "Connection failed: \(error.localizedDescription)"
        }

        isValidating = false
    }
}
