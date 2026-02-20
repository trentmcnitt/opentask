import SwiftUI

/// First-launch setup: server URL and Bearer token entry.
///
/// Validates by calling GET /api/user/preferences with the Bearer token.
/// On success, stores credentials in Keychain via App Group and transitions
/// to the main WebView.
struct SetupView: View {
    @State private var serverURL = ""
    @State private var bearerToken = ""
    @State private var isValidating = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Connect to your OpenTask server to enable push notifications with snooze actions.")
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

                Section("API Token") {
                    SecureField("Bearer token", text: $bearerToken)
                        .textContentType(.password)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)

                    Text("Create a token in Settings > API Tokens on your OpenTask server.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
        !serverURL.isEmpty && !bearerToken.isEmpty && !isValidating
    }

    private func validate() async {
        isValidating = true
        errorMessage = nil

        // Normalize URL: strip trailing slash
        var url = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") {
            url.removeLast()
        }

        // Save temporarily so APIClient can use them
        KeychainHelper.save(key: "serverURL", value: url)
        KeychainHelper.save(key: "bearerToken", value: bearerToken.trimmingCharacters(in: .whitespaces))

        do {
            let isValid = try await APIClient.shared.validateConnection()
            if isValid {
                AppConfig.shared.configure(serverURL: url, bearerToken: bearerToken.trimmingCharacters(in: .whitespaces))
            } else {
                errorMessage = "Server returned an error. Check your token."
                AppConfig.shared.reset()
            }
        } catch {
            errorMessage = "Connection failed: \(error.localizedDescription)"
            AppConfig.shared.reset()
        }

        isValidating = false
    }
}
