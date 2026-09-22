# OpenTask for macOS

A small, purpose-built native macOS app: one window over the OpenTask PWA, a
real menu bar, and APNs notifications with action buttons.

**This is not a Mac Catalyst port**, and it is not the widget extension. A full
Catalyst port of `ios/` was costed at 40-64h and shelved — almost all of that
was compatibility-layer tax on an existing iPhone codebase (quick actions →
Dock menu, `SceneDelegateInterceptor`, three extensions to filter out of the
Mac build, a watchOS target that cannot come along, an open XcodeGen bug).
None of it applies here, because nothing is being bent to fit: this is a new
AppKit/SwiftUI app that happens to share five files with the phone.

The `ios/` project is untouched. This app has its own XcodeGen spec, its own
project file and its own bundle ID, and `cd ios && xcodegen generate` still
produces a byte-identical `OpenTask.xcodeproj`.

## Build and run

```bash
cd macos
xcodegen generate
xcodebuild -project OpenTaskMac.xcodeproj -scheme OpenTaskMac \
  -configuration Debug -destination 'generic/platform=macOS' \
  -derivedDataPath build build

# Run it from the terminal — that is where its log goes (see Logging below)
build/Build/Products/Debug/OpenTaskMac.app/Contents/MacOS/OpenTaskMac
```

`open build/Build/Products/Debug/OpenTaskMac.app` also works and is how to
bring an already-running instance to the front.

Requires macOS 14, and Xcode with a macOS SDK. Nothing needs to be installed
into `/Applications` to try it.

## The one blocker: no macOS provisioning profile

Two things need a macOS **development provisioning profile** for App ID
`io.mcnitt.opentask.mac`, and no such profile exists for this team yet:

| Needs a profile          | Why                                                                               |
| ------------------------ | --------------------------------------------------------------------------------- |
| `aps-environment`        | APNs registration fails without it — no push, so no notifications from the server |
| Data protection keychain | Without an `application-identifier` entitlement every call returns -34018         |

Creating one requires a signed-in Apple ID, and on this Mac Xcode currently
rejects the account (`Unable to log in with account 'misc_dev_work@pm.me'`).
Sign in again under Xcode ▸ Settings ▸ Accounts, then:

```bash
xcodebuild -project OpenTaskMac.xcodeproj -scheme OpenTaskMac \
  -configuration Debug -destination 'generic/platform=macOS' \
  -derivedDataPath build -allowProvisioningUpdates \
  CODE_SIGN_ENTITLEMENTS=OpenTaskMac/OpenTaskMac-Push.entitlements build
```

`OpenTaskMac.entitlements` (sandbox + network client) is what XcodeGen writes
and what the default build uses. `OpenTaskMac-Push.entitlements` is the same
file plus `aps-environment`; keep the two in sync.

Until then the app runs and works — it just cannot receive push. It falls back
to the **legacy keychain**, which needs no entitlement (see the long comment in
`ios/Shared/KeychainHelper.swift`). The switch is automatic and based on what
the binary is actually signed with, so adding a profile needs no code change —
but the two keychains do not share items, so the first launch after that will
ask for the server URL once more.

### Notification permission

Separate from the entitlement: macOS asks the user once. If it was denied, the
app logs `Notification authorization: 1` at launch and the only fix is System
Settings ▸ Notifications ▸ OpenTask.

## Logging

Everything the app diagnoses goes to `print()`, as it does on the phone. On
macOS that means **stdout**, which is not the unified log — `/usr/bin/log`
will not show it. Launch the app from a terminal to see it. The app sets
line-buffered stdout at startup so lines appear as they happen rather than
whenever a 4 KB buffer fills.

Worth knowing: `log` is a broken shell builtin on this Mac. Always
`/usr/bin/log`.

## Debug hooks

Debug builds only, mirroring the iPhone app's launch-environment seeding:

```bash
# Configure without typing into the setup form
OPENTASK_SEED_SERVER_URL=https://tasks-dev.example.com \
  build/Build/Products/Debug/OpenTaskMac.app/Contents/MacOS/OpenTaskMac

# ... with a Bearer token too, which is otherwise only provisioned once APNs works
OPENTASK_SEED_SERVER_URL=https://tasks-dev.example.com \
OPENTASK_SEED_BEARER_TOKEN=<token> \
  build/Build/Products/Debug/OpenTaskMac.app/Contents/MacOS/OpenTaskMac

# Back to a clean first run. The Keychain lives OUTSIDE the app container, so
# deleting ~/Library/Containers/io.mcnitt.opentask.mac is not enough.
OPENTASK_RESET=1 build/Build/Products/Debug/OpenTaskMac.app/Contents/MacOS/OpenTaskMac
```

## What it does

| Surface       | Behaviour                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------- |
| Window        | One `Window` scene (not `WindowGroup`) hosting a WKWebView on the configured server         |
| Setup         | Server URL entry, validated against `/login`; `https://` is assumed when no scheme is typed |
| Menu ▸ File   | New Task (⌘N)                                                                               |
| Menu ▸ Tasks  | Reload (⌘R), Snooze All +1hr (⌃⌘1), +2hr (⌃⌘2), to Tomorrow (⌃⌘3)                           |
| Notifications | `TASK_REMINDER`, `TASK_SUMMARY`, `SLOT_REMINDER` categories with Done / +1hr / All +1hr /   |
|               | Complete all, plus the silent `dismiss` / `dismiss-all` / `badge-update` pushes             |
| Dock          | Badge count; closing the window parks the app instead of quitting it                        |

**The chain to know about:** the web app only provisions the Bearer token when
it sees an APNs device token (`PreferencesProvider.provisionBearerToken`). So
no push ⇒ no token in the Keychain ⇒ the Snooze All menu items say "Not
connected yet" and the session bootstrap stays inert. All three come back
together the moment push works; `OPENTASK_SEED_BEARER_TOKEN` is the way to test
them before then.

## How much of this has actually been run

The table above is what the code does, not a test report. On the build machine
(macOS 26.6.2 / Xcode 26.6), with the displays asleep for most of it:

- **Verified:** builds clean with no warnings; launches sandboxed and signed;
  the setup window renders; the menu bar is real (`File ▸ New Task…`,
  `Tasks ▸ Reload / Snooze All ×3`); Reload, New Task and Snooze All each fire
  their action; the WKWebView loads a real server over HTTPS from inside the
  sandbox; the legacy-keychain fallback saves and reads; `ios/` regenerates
  byte-identically and all four iOS targets still build.
- **Not exercised:** the Connect button end to end, every notification action
  handler, the session bootstrap and the /login rescue (both need a Bearer
  token, which needs push), reopening the window after closing it, and what
  the web app looks like in the window.

## Reused from `ios/`

Compiled into this target directly, not copied:

- `ios/Shared/APIClient.swift`, `DateHelpers.swift`, `OpenTaskModels.swift`,
  `NotificationConstants.swift` — unchanged, platform-agnostic.
- `ios/Shared/KeychainHelper.swift` — one macOS branch, documented in the file.
- `ios/OpenTask/SessionBootstrapper.swift` — by file, because it is not in
  `Shared/` (that folder is compiled into the watchOS target, which has no
  WebKit) and because it encodes the `/api/auth/session-from-token` contract,
  which should exist once. **Editing it for iOS changes this app too.**

Everything else is written for macOS. `ContentView`/`WebViewHost` are not ports
of `ios/OpenTask/WebView.swift`: the pull-to-refresh control, the Dynamic Type
→ CSS bridge and the safe-area handling in that file have no macOS equivalent,
while `target="_blank"` handling, `allowsMagnification` and `isInspectable` do.

## Deliberate differences from the iPhone app

- **No `dismissAllNotifications()` on activation.** That call clears delivered
  notifications on every _other_ device; on a Mac, "became active" fires every
  time you click back into the window.
- **Foreground banners are suppressed only when the app is active AND has a
  visible window.** On a phone, app-open means the list is the whole screen.
  On a Mac it can be behind three other windows.
- **No `.criticalAlert`.** It needs a per-App-ID entitlement Apple grants by
  request, and asking for it would fail provisioning for a capability this app
  does not use.
- **No `opentask://` URL scheme.** The Designed-for-iPad build currently owns
  it for widget taps, and registering it here could steal them.

## Widget extension (`OpenTaskMacWidgets`)

A genuinely native macOS `app-extension` target, not shared with `ios/` at
the binary level — WidgetKit has no Mac Catalyst slice at all, verified from
the SDK. It ports `ios/OpenTaskWidgets/` (all three kinds: Reminders, Tasks,
Track) by referencing those `.swift` files directly from `project.yml` rather
than copying them, so a future change to reminder/task/track behavior only
has to happen once. Two platform-specific changes were needed in that shared
code, both guarded with `#if os(iOS)` / `#if os(macOS)` so `ios/`'s own build
is untouched: `WidgetTheme.rowTitleLineHeight` (UIKit's line-height call has
no direct AppKit equivalent — see the doc comment on that property) and the
Lock Screen accessory families (`.accessoryRectangular`/`.accessoryCircular`
are `@available(macOS, unavailable)` — hard compile errors on native macOS,
unlike the Designed-for-iPad build).

Shares the App Group and `keychain-access-groups` entitlements with
`OpenTaskMac` (see the long comment on the app target's entitlements in
`project.yml`) so its timeline providers can read the same Bearer token and
`WidgetStore` cache the app writes.

**Verified:** the app and the extension both build and embed cleanly
(`.appex` inside `OpenTaskMac.app/Contents/PlugIns/`), both binaries' signed
entitlements carry the App Group + keychain-access-groups grants, `pluginkit
-m -v -p com.apple.widgetkit-extension` shows it registered, running the
`.appex` binary directly reports "An XPC Service cannot be run directly"
(correct behavior for an XPC-backed extension, not a crash), and `ios/`
still regenerates a byte-identical `project.pbxproj` with all its targets
building.

**Not verified without a human placing it on a desktop:** actual timeline
rendering, the `+1`/check-off `AppIntent` buttons, and the `ChevronPager`.
`chronod`'s unified-log trace on this dev-signed build shows it discovering
the extension and requesting a reload, with some "purging... isApple? false"
housekeeping and a FOREIGN KEY constraint message that read as normal for a
not-yet-placed third-party extension — no `RBSRequestErrorDomain` launch
failure, which is the known real bug pattern from earlier this week's iOS
widget debugging (see the hub capability notes).

## Not in this pass

- **Notification content extension** (the long-press snooze grid). A throwaway
  spike on macOS 26.6 confirmed that a `UNNotificationContentExtension` _does_
  render under a native macOS app, contradicting years of developer reports
  (which were all for older macOS). Whether buttons _inside_ its custom view
  work — `UNNotificationExtensionUserInteractionEnabled` — is still untested.
  The plain category action buttons work regardless, so the fallback is
  graceful. Adding one means a second `app-extension` target in `project.yml`
  (keep it sandboxed) — the App Group and the Keychain access group it would
  need already exist now, built for the widget extension above, so that part
  is no longer new work.
- **Dock menu, Spotlight, Focus filters.**
