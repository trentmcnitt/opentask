import Foundation

/// The server URL a person types into setup, as the apps store it.
///
/// Shared by the iPhone's and the Mac's `SetupView`, which used to normalize
/// separately: the Mac assumed https:// when no scheme was typed, the iPhone
/// didn't, so "tasks.example.com" connected on the Mac and failed on the
/// iPhone with "Invalid URL" or a connection error.
enum ServerURL {
    /// Trim whitespace, drop trailing slashes, and assume `https://` when no
    /// scheme was typed ("tasks.example.com" is what people actually type).
    /// A typed scheme is kept as it is, so a plain-http server on a local
    /// network still works.
    static func normalize(_ input: String) -> String {
        var url = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") {
            url.removeLast()
        }
        if !url.isEmpty && !url.contains("://") {
            url = "https://" + url
        }
        return url
    }
}
