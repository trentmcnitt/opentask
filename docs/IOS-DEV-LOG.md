# iOS App Development Log

Tracking the journey of building a native iOS app for OpenTask with Claude Code.

## Why

Web Push on iOS doesn't support action buttons. Users can't snooze or complete tasks from the lock screen without opening the app. A thin native shell with APNs and a Notification Content Extension gives full notification control.

## Architecture

- **App:** WKWebView shell loading the existing PWA. Native code handles push notifications only.
- **Server:** APNs sends alongside existing Web Push + Pushover. `apns2` npm package with p8 token auth.
- **Distribution:** Ad Hoc for 2 devices. Other self-hosted users build from source with their own Apple Developer account.

## Progress

### Phase 1: Server-Side APNs Support

- [x] `apns2` dependency installed
- [x] `apns_devices` table added to schema
- [x] `src/core/notifications/apns.ts` — send/dismiss/isConfigured
- [x] `POST/DELETE /api/push/apns/register` — device registration
- [x] `POST /api/tasks/bulk/snooze-overdue` — server-side overdue query for "All" button
- [x] Overdue checker sends APNs alongside Web Push
- [x] Critical alerts send APNs alongside Pushover
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
- [ ] Physical device testing
- [ ] All checklist items verified

## Lessons Learned

### xcodegen gotchas

- **Entitlements**: Use `entitlements: properties:` in `project.yml` — xcodegen generates the file content from properties. Using `entitlements: path:` alone causes xcodegen to overwrite the file with empty content.
- **Info.plist for extensions**: xcodegen overwrites Info.plist on every generation. Workaround: backup before `xcodegen generate`, restore after. The `NSExtension` dict with custom keys gets wiped otherwise.
- **`info: properties:` without `path:`**: Fails with "Decoding failed at 'path': Nothing found". Must specify `info: path:` even for extension targets.

### Swift version

- Started with Swift 6.0 but hit strict concurrency errors (`static property 'shared' is not concurrency-safe`, `main actor-isolated code` issues). Dropped to Swift 5.9 which compiles cleanly. Can revisit Swift 6 later with proper `@Sendable` / actor annotations.

### iOS deployment target

- Originally planned iOS 16.0. Bumped to iOS 17.0 because `@Observable` macro requires it. iOS 17 covers 90%+ of devices so no practical concern for Ad Hoc distribution.

### Pre-existing SQLite date comparison bug

- `due_at < datetime('now')` is used in overdue-checker and critical-alerts queries
- **Bug:** dates stored as ISO strings (with `T` separator) don't compare correctly to `datetime('now')` output (space separator) on the same day. `T` > space in ASCII, so `2026-02-19T10:00:00Z < '2026-02-19 17:00:00'` returns false
- **Impact:** Same-day overdue tasks are not detected by the overdue checker. Tasks overdue from previous days work because `2026-02-18T...` < `2026-02-19 ...`
- **Fix:** Wrap column in `datetime()` function: `datetime(due_at) < datetime('now')`
- Applied fix in the new `snooze-overdue` endpoint; pre-existing instances in overdue-checker.ts and critical-alerts.ts still have the bug
