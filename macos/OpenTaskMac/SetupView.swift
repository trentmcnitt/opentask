import SwiftUI

/// First-launch setup: server URL entry.
///
/// Near-identical to `ios/OpenTask/SetupView.swift` — it was already
/// high-level SwiftUI. What changed is only what does not exist on a Mac:
/// `keyboardType`, `autocapitalization` and `textContentType(.URL)` are iOS
/// API, `NavigationStack` earns nothing in a single fixed window, and a Mac
/// user expects Return to submit the form.
///
/// Validation is deliberately unauthenticated — it loads `/login` and checks
/// for any non-error response. The user logs in in the web view afterwards,
/// and the Bearer token is provisioned from there.
struct SetupView: View {
    @State private var serverURL = ""
    @State private var isValidating = false
    @State private var errorMessage: String?

    /// A centred card rather than the iPhone's `Form`. A grouped Form top-
    /// anchors its sections, which in a 1180×860 window leaves one text field
    /// stranded above half a screen of nothing; the window is sized for the
    /// task list it will show a moment later, not for this.
    var body: some View {
        VStack(spacing: 22) {
            VStack(spacing: 10) {
                Image(systemName: "checklist")
                    .font(.system(size: 40, weight: .light))
                    .foregroundStyle(.tint)

                Text("Connect to OpenTask")
                    .font(.title2)
                    .fontWeight(.semibold)

                Text("Enter your server URL. The window loads your OpenTask instance, and notifications with Done and Snooze actions arrive here once you log in.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 8) {
                TextField("https://tasks.example.com", text: $serverURL)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled(true)
                    .onSubmit { submit() }

                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack(spacing: 10) {
                if isValidating {
                    ProgressView().controlSize(.small)
                }
                Button("Connect", action: submit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit)
            }
        }
        .frame(width: 420)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle("OpenTask Setup")
    }

    private var canSubmit: Bool {
        !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isValidating
    }

    private func submit() {
        guard canSubmit else { return }
        Task { await validate() }
    }

    private func validate() async {
        isValidating = true
        errorMessage = nil
        defer { isValidating = false }

        // Normalise: trim, drop trailing slashes, and assume https:// when no
        // scheme was typed — "tasks.example.com" is what people actually type.
        var url = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") {
            url.removeLast()
        }
        if !url.contains("://") {
            url = "https://" + url
        }

        guard let checkURL = URL(string: "\(url)/login") else {
            errorMessage = "Invalid URL"
            return
        }

        do {
            var request = URLRequest(url: checkURL)
            request.timeoutInterval = 10
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, (200...399).contains(http.statusCode) {
                AppConfig.shared.configure(serverURL: url)
            } else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                errorMessage = "Server not reachable (HTTP \(code))"
            }
        } catch {
            errorMessage = "Connection failed: \(error.localizedDescription)"
        }
    }
}
