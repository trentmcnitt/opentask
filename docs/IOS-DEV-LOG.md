# iOS App Development Log

Tracking the journey of building a native iOS app for OpenTask with Claude Code.

## Why

Web Push on iOS doesn't support action buttons. Users can't snooze or complete tasks from the lock screen without opening the app. A thin native shell with APNs and a Notification Content Extension gives full notification control.

## Architecture

- **App:** WKWebView shell loading the existing PWA. Native code handles push notifications only.
- **Server:** APNs sends alongside existing Web Push. `apns2` npm package with p8 token auth.
- **Distribution:** Ad Hoc for 2 devices. Other self-hosted users build from source with their own Apple Developer account.

## Progress

### Phase 1: Server-Side APNs Support

- [x] `apns2` dependency installed
- [x] `apns_devices` table added to schema
- [x] `src/core/notifications/apns.ts` — send/dismiss/isConfigured
- [x] `POST/DELETE /api/push/apns/register` — device registration
- [x] `POST /api/tasks/bulk/snooze-overdue` — server-side overdue query for "All" button
- [x] Overdue checker sends APNs alongside Web Push
- [x] Critical alerts send APNs with time-sensitive interruption level
- [x] APNs dismissal added to all action/snooze/done endpoints
- [x] Env vars and deploy config updated
- [x] Behavioral tests for apns_devices CRUD
- [x] Integration tests for registration endpoint and bulk snooze-overdue
- [x] Quick check + integration tests passing

### Phase 2: iOS App Shell

- [x] Xcode project structure (xcodegen with `project.yml`)
- [x] WKWebView with persistent cookies
- [x] Setup view (server URL + Bearer token)
- [x] Keychain via App Group (`group.io.mcnitt.opentask`)
- [x] APNs registration + notification categories in AppDelegate
- [x] App icon (resized from 512 to 1024)
- [x] Notification content extension stub
- [x] Both targets (OpenTask + OpenTaskNotification) build cleanly

### Phase 3: Notification Categories

- [x] UNNotificationCategory with Done/+1hr/All+1hr (registered in AppDelegate)
- [x] Action handling in AppDelegate (DONE/SNOOZE_1HR/SNOOZE_ALL_1HR/SNOOZE_CUSTOM)

### Phase 4: Content Extension

- [x] SnoozeGridView (4x3 SwiftUI grid) — preset times, increments, decrements
- [x] Dynamic action button updates via `extensionContext.notificationActions`
- [x] API calls from extension via shared APIClient (Keychain App Group)
- [x] DateHelpers Swift port (snapToNextPreset, adjustByMinutes/Days, formatDelta, etc.)
- [x] Both targets build cleanly with Phase 4 code

### Phase 5: Testing

- [x] Server-side quick check passes (482 behavioral, 0 errors)
- [x] Integration tests pass (128 tests, 15 files)
- [x] Simulator testing: setup form, WebView login, dashboard, push banners
- [x] Content extension renders snooze grid in simulator (pull-down gesture)
- [x] Grid buttons interactive: presets, increments, decrements all work
- [x] Dynamic action button labels update with computed delta
- [x] APNs env vars configured on dev server
- [x] TestFlight build v1.0.0 (2) uploaded to App Store Connect
- [ ] Physical device testing via TestFlight
- [ ] APNs delivery verified on physical device
- [ ] Content extension interaction verified on physical device
- [ ] All checklist items verified

## Lessons Learned

### xcodegen gotchas

- **Entitlements**: Use `entitlements: properties:` in `project.yml` — xcodegen generates the file content from properties. Using `entitlements: path:` alone causes xcodegen to overwrite the file with empty content.
- **Info.plist for extensions**: Do NOT use `info: path:` in project.yml — xcodegen overwrites the file on every generation, stripping the `NSExtension` dictionary. Instead, use `INFOPLIST_FILE` and `GENERATE_INFOPLIST_FILE: false` in build settings. This tells Xcode to use the plist as-is without xcodegen touching it.
- **`info: properties:` without `path:`**: Fails with "Decoding failed at 'path': Nothing found". Must specify `info: path:` even for extension targets.
- **Extension version numbers**: The extension's `CFBundleVersion` and `CFBundleShortVersionString` in Info.plist must match the main app's `CURRENT_PROJECT_VERSION` and `MARKETING_VERSION` in project.yml. Update both when bumping versions.

### Swift version

- Started with Swift 6.0 but hit strict concurrency errors (`static property 'shared' is not concurrency-safe`, `main actor-isolated code` issues). Dropped to Swift 5.9 which compiles cleanly. Can revisit Swift 6 later with proper `@Sendable` / actor annotations.

### iOS deployment target

- Originally planned iOS 16.0. Bumped to iOS 17.0 because `@Observable` macro requires it. iOS 17 covers 90%+ of devices so no practical concern for Ad Hoc distribution.

### SQLite date comparison bug (fixed)

- `due_at < datetime('now')` compared ISO strings (with `T` separator) against `datetime('now')` output (space separator). On the same day, `T` > space in ASCII, so same-day overdue tasks weren't detected.
- **Fix:** `datetime(due_at) < datetime('now')` — applied across all queries (overdue-checker, critical-alerts, snooze-overdue).

### UserNotificationsUI framework linking

- The notification content extension requires `UserNotificationsUI` framework at runtime, not just `UserNotifications`
- Swift auto-linking from `import UserNotificationsUI` alone is not sufficient — the framework must be explicitly listed as a dependency
- In project.yml: `dependencies: - sdk: UserNotificationsUI.framework`
- Without this, the extension loads but the view is blank. The crash log shows "Unable to find NSExtensionContextClass (\_UNNotificationContentExtensionVendorContext)"

### Simulator notification testing

- `xcrun simctl push` delivers banner notifications but content extensions are limited
- **Pull-down gesture works** to expand notifications in the simulator — drag down on the banner when it appears
- Content extension interaction (tapping buttons in the expanded view) works in the simulator
- On iOS 26.2: use `touch` (down+up) instead of `tap` to focus SwiftUI text fields — `tap` doesn't reliably activate them
- WKWebView content is not in the accessibility tree; use screenshot coordinates for web interactions
