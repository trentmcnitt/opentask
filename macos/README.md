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
build/Build/Products/Debug/OpenTask.app/Contents/MacOS/OpenTask
```

`open build/Build/Products/Debug/OpenTask.app` also works and is how to
bring an already-running instance to the front. The app FILE is
`OpenTask.app` (2026-09-22: `PRODUCT_NAME` set explicitly in `project.yml` —
it used to default to the target name, `OpenTaskMac.app`, even though
`CFBundleDisplayName` was already "OpenTask"). The target name, scheme names
(`OpenTaskMac`, `OpenTaskMacWidgets`) and bundle IDs are unchanged.

Requires macOS 14, and Xcode with a macOS SDK. Nothing needs to be installed
into `/Applications` to try it.

## Provisioning profile — RESOLVED (was: no macOS profile for this team)

**Historical note, kept for context.** This section used to say there was no
macOS development provisioning profile for App ID `io.mcnitt.opentask.mac`,
blocked on a signed-out Apple ID. Both are resolved as of 2026-09-22:
automatic signing now fetches a real "Mac Team Provisioning Profile" for this
App ID without any manual step, `aps-environment` and the data protection
keychain both work, and — confirmed while building `OpenTaskMacWidgets` — so
does `com.apple.security.application-groups`, though not without a landmine
(see the long comment on `OpenTaskMac`'s entitlements in `project.yml`: a
Mac Team Provisioning Profile grants a wildcard `keychain-access-groups`
until you request an explicit App Group, at which point Xcode stops
synthesizing that wildcard and the Keychain briefly stops working until you
list `keychain-access-groups` explicitly too).

```bash
xcodebuild -project OpenTaskMac.xcodeproj -scheme OpenTaskMac \
  -configuration Debug -destination 'generic/platform=macOS' \
  -derivedDataPath build -allowProvisioningUpdates \
  CODE_SIGN_ENTITLEMENTS=OpenTaskMac/OpenTaskMac-Push.entitlements build
```

`OpenTaskMac.entitlements` (sandbox + network client + App Group +
`keychain-access-groups`) is what XcodeGen writes and what the default build
uses. `OpenTaskMac-Push.entitlements` is the same file plus `aps-environment`;
keep the two in sync. Both now build and run successfully — verified directly
(2026-09-22): `xcodebuild ... build` with neither `CODE_SIGN_ENTITLEMENTS` nor
`-allowProvisioningUpdates` also succeeds and signs the same App Group +
Keychain grants, since only `aps-environment` genuinely needs the Push
variant.

**One thing to know about that `CODE_SIGN_ENTITLEMENTS=...` build command**:
it is a _scheme-wide_ xcodebuild override, so it also signs
`OpenTaskMacWidgets` with the app's Push entitlements — the widget extension
picks up `aps-environment` it has no use for (harmless: it never registers
for push) and `-allowProvisioningUpdates` will have enabled Push
Notifications on the App ID `io.mcnitt.opentask.mac.widgets` in the
Developer Portal as a side effect. Worth knowing before assuming an
entitlement only added to `OpenTaskMacWidgets`'s own `project.yml` block
reaches a Push build — it doesn't; `OpenTaskMac-Push.entitlements` is
hand-written per-target, not per-scheme.

The two keychains (legacy vs. data protection) do not share items — a
profile arriving after a legacy-keychain launch means the first launch after
that asks for the server URL once more. See the long comment in
`ios/Shared/KeychainHelper.swift` for the full mechanics of that switch.

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
  build/Build/Products/Debug/OpenTask.app/Contents/MacOS/OpenTask

# ... with a Bearer token too, which is otherwise only provisioned once APNs works
OPENTASK_SEED_SERVER_URL=https://tasks-dev.example.com \
OPENTASK_SEED_BEARER_TOKEN=<token> \
  build/Build/Products/Debug/OpenTask.app/Contents/MacOS/OpenTask

# Back to a clean first run. The Keychain lives OUTSIDE the app container, so
# deleting ~/Library/Containers/io.mcnitt.opentask.mac is not enough.
OPENTASK_RESET=1 build/Build/Products/Debug/OpenTask.app/Contents/MacOS/OpenTask
```

## What it does

| Surface       | Behaviour                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------- |
| Window        | One `Window` scene (not `WindowGroup`) hosting a WKWebView on the configured server          |
| Setup         | Server URL entry, validated against `/login`; `https://` is assumed when no scheme is typed  |
| Menu ▸ File   | New Task (⌘N)                                                                                |
| Menu ▸ Tasks  | Reload (⌘R), Snooze All +1hr (⌃⌘1), +2hr (⌃⌘2), to Tomorrow (⌃⌘3)                            |
| Notifications | `TASK_REMINDER`, `TASK_SUMMARY`, `SLOT_REMINDER` categories with Done / +1hr / All +1hr /    |
|               | All → \<time slot\> (cached from `GET /api/time-slots`, "Next period" first) / Complete all, |
|               | plus the silent `dismiss` / `dismiss-all` / `badge-update` pushes                            |
| Dock          | Badge count; closing the window parks the app instead of quitting it                         |

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
  handler, reopening the window after closing it, and what the web app looks
  like in the window.

**Addendum, 2026-09-22 (widget extension session).** The session that added
`OpenTaskMacWidgets` also exercised more of the above than previously listed,
via the debug seed hook against `tasks-dev.tk11.mcnitt.io` (`.secrets`
credentials, real server): the session bootstrap DOES run and recover from a
bad seeded token (401 → the WKWebView loaded the real login page → a real
Bearer token got provisioned via the JS bridge), and APNs registration
succeeds cleanly on every build. Two operational cautions this surfaced that
whoever tests next should know before assuming a clean slate:

- **A stale APNs device registration likely exists on `tasks-dev` for this
  Mac.** The seed-then-`OPENTASK_RESET=1` cycle used to test the Keychain fix
  wipes the local Keychain but `AppConfig.reset()` does not call
  `unregisterDevice` — the registration made during that test was never torn
  down server-side.
- **`~/Applications/OpenTaskMac.app` (same bundle ID, `io.mcnitt.opentask.mac`,
  an earlier build without the App Group/Keychain work in this session) was
  running throughout this session**, and every build here registered another
  LaunchServices claim for that same bundle ID from the worktree's own
  `build/` path. Before anyone tests on a real desktop: quit the
  `~/Applications` copy, and expect to need the same LaunchServices cleanup
  the 2026-09-16 Mac widget session documented for the iOS side (duplicate
  claims for one bundle ID is exactly that class of problem) if the widget
  gallery doesn't show a clean single entry.

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
has to happen once. Platform-specific differences in that shared code are all
guarded with `#if os(iOS)` / `#if os(macOS)` so `ios/`'s own build is
untouched: `WidgetTheme.rowTitleLineHeight` (UIKit's line-height call has
no direct AppKit equivalent — see the doc comment on that property), the
Lock Screen accessory families (`.accessoryRectangular`/`.accessoryCircular`
are `@available(macOS, unavailable)` — hard compile errors on native macOS,
unlike the Designed-for-iPad build), and how `RemindersListView`/
`TasksListView` size a `systemLarge` row (added 2026-09-22 for macOS; iOS
got its own version of the same fix 2026-09-23 — see below for what stayed
platform-specific). The ORIGINAL bug (macOS only, 2026-09-22): iOS reserved
a flat 2 lines per title; on macOS that flat reservation turned out to be
SMALLER than the row's own fixed 36pt check-off/dot hit target, so the hit
target — not the text — was silently setting every row's height (a one-line
title still cost the height of two empty lines). The fix measures each
title's REAL line count with the platform's own text-layout API
(`WidgetTheme.measuredLineCount`, fed a card width threaded down through a
`GeometryReader` placed OUTSIDE `ViewThatFits`, never inside a candidate),
uses that for both the marker's height and the text reservation, and the
row ceiling is raised from 6 to 10 to use the height that frees up. See the
"row-height truthing" comment block on `WidgetTheme.swift` for the full
diagnosis, including the 2026-09-23 addendum.

**iOS is no longer untouched** (2026-09-23, Trent's iPhone screenshots
showed the same family of complaints — a gap under one-line titles, 2-line
truncation, wanting more rows visible): iOS now shares the SAME
`measuredLineCount`/`GeometryReader` mechanism and the SAME raised ceiling
(10, both platforms), but two things stay platform-specific rather than
converging all the way to macOS's behavior: **the cap** — iOS still caps a
title at `WidgetTheme.iOSMaxTitleLines` (3), where macOS never caps at all
("I don't want to truncate the text until three lines" vs. macOS's "we
can't truncate the text" — a phone's Home Screen has far less room than a
desktop widget, so iOS keeps a ceiling macOS doesn't need); and **the
marker floor** — iOS's 36pt marker column is a FINGER touch target and
never shrinks below that even when the measured text is shorter
(`max(reservedHeight, WidgetTheme.rowMarkerSize)`), where macOS's marker
still has no floor at all (a mouse pointer needs none, and this is the same
36pt-vs-28pt asymmetry the original 2026-09-22 diagnosis found — it just
means iOS deliberately keeps the finger-target side of that asymmetry
instead of fully adopting macOS's fix). `systemMedium` on iOS is
UNTOUCHED by any of this — it still reserves a flat one line per title,
with no `GeometryReader`/measurement at all; a 4×2 has no height to spare
on it. Also unaffected on iOS: `systemMedium`'s row ceiling stays whatever
`maxRows` (3) it was passed — only `systemLarge` uses the raised 10.

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
