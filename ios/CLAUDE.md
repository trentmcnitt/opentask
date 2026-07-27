# iOS App — Development Reference

Detailed development reference for the OpenTask iOS companion app. See the main `AGENTS.md` for the overview, targets, shared code, build instructions, and API endpoints.

## Notification Mechanisms

1. **Default actions** (AppDelegate): Done, +1hr, All +1hr buttons — used from lock screen or when content extension is unavailable
2. **Silent dismissal**: Server sends `content-available: 1` push with `type: "dismiss"` when a task is snoozed/completed from the web UI — iOS app removes matching delivered notifications
3. **Content extension** (long-press): Interactive 3x4 snooze grid (presets, increments, decrements) — extension makes API calls directly and dismisses
4. **Slot batch checklist** (`SLOT_REMINDER`, long-press): a §6 time-slot notification expands into a checklist of that slot's pending reminders (fetched live from `GET /api/reminders`, filtered by the payload's `slot_id`); rows stage check-marks, the "Complete N checked" action button commits them in ONE `POST /api/tasks/bulk/complete`, and "Complete all" takes the whole slot. **Device-test only** — content extensions cannot be invoked in the simulator (see below), so the long-press path is unverifiable there and must not be attempted.

## Widgets (`OpenTaskWidgets`)

WidgetKit extension (`io.mcnitt.opentask.widgets`, iOS 17, App Group `group.io.mcnitt.opentask`) with two independent widget kinds — `OpenTaskReminders` and `OpenTaskTasks`. Separate kinds, not one configurable widget, so each gets its own refresh budget (REDESIGN-V03 §8).

- **Data**: timeline providers call `APIClient` (`GET /api/reminders`, `/api/tasks?done=false`, `/api/projects`) with the Keychain credentials shared through the App Group. Every successful payload is cached in App Group `UserDefaults` (`WidgetStore`); a failed fetch renders the cache with an "as of HH:MM" note rather than blanking.
- **Interaction**: `AppIntent` buttons only — check-off, `+1` progress, and the `‹ ›` pagers. Widgets get no swipe gestures (§8), and Lock Screen accessory families are glanceable-only because interactive widgets are inert on a locked device.
- **Budget**: reloads triggered by a widget's own intent, and by the app foregrounding, are free. Unprompted refreshes are budgeted, so the timeline policy is `.after(+30 min)` plus zero-cost entries pre-scheduled at each time-slot boundary and upcoming due time.
- **Deep links**: `opentask://today`, `opentask://reminders`, `opentask://task/<id>` — resolved to web paths in `OpenTaskApp.handleWidgetLink`.

### The two project specs

`project.yml` is canonical. `project-sim.yml` is **generated** from it by `ios/scripts/make-sim-spec.py` — it is the same spec minus the watchOS target, because generating and building the canonical spec requires the watchOS SDK to be installed, and without it every `xcodebuild` fails before compiling a single file (including iOS-only builds).

```bash
python3 ios/scripts/make-sim-spec.py            # regenerate project-sim.yml
python3 ios/scripts/make-sim-spec.py --check    # fail if it's stale
cd ios && xcodegen generate                     # canonical (OpenTask.xcodeproj)
cd ios && xcodegen generate --spec project-sim.yml   # sim (OpenTaskSim.xcodeproj)
```

Never hand-edit `project-sim.yml` — add targets to `project.yml` and regenerate, or the new target silently builds on one spec and not the other.

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
- **watchOS device builds**: `devicectl` cannot reliably connect to the Apple Watch directly (shows "unavailable" even with Developer Mode on). XcodeBuildMCP's `build_device` and `install_app_device` also don't work for watchOS targets. Instead, deploy the watch app **through the iPhone** — the watch app is embedded in the iOS app bundle and iOS automatically syncs it to the paired watch over Bluetooth:

  ```bash
  # 1. Build (from ios/ directory) — builds both iOS and watchOS targets
  xcodebuild -project OpenTask.xcodeproj -scheme OpenTaskWatch \
    -destination 'generic/platform=watchOS' \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    -derivedDataPath build build

  # 2. Install the iOS app on the iPhone (the embedded watch app syncs automatically)
  xcrun devicectl device install app --device IPHONE_UDID \
    build/Build/Products/Debug-iphoneos/OpenTask.app
  ```

  - Get the iPhone UDID: `xcrun devicectl list devices`
  - The watch app lives at `OpenTask.app/Watch/OpenTaskWatch.app` inside the iOS bundle
  - If the watch shows "unavailable" in devicectl, try `sudo pkill -9 remoted` on the Mac to force a reconnection (though direct watch install is not needed with this approach)
