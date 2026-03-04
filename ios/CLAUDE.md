# iOS App — Development Reference

Detailed development reference for the OpenTask iOS companion app. See the main `AGENTS.md` for the overview, targets, shared code, build instructions, and API endpoints.

## Notification Mechanisms

1. **Default actions** (AppDelegate): Done, +1hr, All +1hr buttons — used from lock screen or when content extension is unavailable
2. **Silent dismissal**: Server sends `content-available: 1` push with `type: "dismiss"` when a task is snoozed/completed from the web UI — iOS app removes matching delivered notifications
3. **Content extension** (long-press): Interactive 3x4 snooze grid (presets, increments, decrements) — extension makes API calls directly and dismisses

## Simulator Limitations

- **Notification content extensions cannot be tested in the simulator.** Long-press expansion is a known Apple limitation across all Xcode versions. Use a physical device.
- **watchOS notification actions cannot be tested in the simulator.** Mirrored notifications and action forwarding require a physical iPhone + Apple Watch pair.
- `xcrun simctl push` delivers banners but does not invoke service or content extensions.
- iOS 18.2 simulator: apps don't appear in Settings (known bug, fixed in 18.4+).

## Physical Device Caution

- **Avoid `devicectl device process launch` on a physical device** unless specifically needed. It kills the running app process, which can reset app state and force re-entry of credentials. Prefer letting the user launch the app themselves after install.
- **`install_app_device` (XcodeBuildMCP) / `devicectl device install app` is safe** — it replaces the binary without losing Keychain data or app state.

## XcodeBuildMCP Workarounds

XcodeBuildMCP is an MCP tool server for building and interacting with iOS simulators and devices from Claude Code.

- On iOS 26+, use `touch` (down+up) instead of `tap` to focus SwiftUI text fields — `tap` doesn't reliably activate them.
- WKWebView content is not exposed in the accessibility tree. Use screenshot coordinates for web view interactions.
- **watchOS device builds**: XcodeBuildMCP's `build_device` and `install_app_device` don't work reliably for watchOS targets (hardcoded to iOS platform, install reports success but app isn't actually installed). Use xcodebuild and devicectl directly instead:
  - Build: `xcodebuild -project OpenTask.xcodeproj -scheme OpenTaskWatch -destination 'platform=watchOS,id=DEVICE_ID' -allowProvisioningUpdates -allowProvisioningDeviceRegistration build`
  - Get the Watch device ID: `xcodebuild -scheme OpenTaskWatch -showdestinations` (different from the UDID in `list_devices`)
  - Install: `xcrun devicectl device install app --device WATCH_UDID path/to/OpenTaskWatch.app`
  - Launch: `xcrun devicectl device process launch --device WATCH_UDID io.mcnitt.opentask.watchapp`
  - Verify: `xcrun devicectl device info apps --device WATCH_UDID | grep opentask`
