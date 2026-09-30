# Screenshots

Every product screenshot — the docs site, the README, the portfolio — comes from one command:

```bash
npm run screenshots                 # → .tmp/screenshots/<today>/
npm run screenshots -- <out dir>    # somewhere else
```

About a minute on an M-series Mac with a warm build. The output directory holds the images plus `manifest.json` and `README.md`, which list every file with its pixel size, theme, what it shows and where it is meant to go. `.tmp/` is gitignored; nothing is committed or copied anywhere by the command.

## What it does

`scripts/screenshots/run.sh`, in order:

1. **Build** — `next build` with a fixed build stamp (the sidebar prints `v<version> · <build date>`). Skip with `SCREENSHOTS_SKIP_BUILD=1` to reuse `.next`.
2. **Seed** — `scripts/screenshots/seed.ts` writes a fresh throwaway SQLite database (`<out>/screenshots.db`) with one user, `sample`: five coloured projects, ~33 tasks across every priority with labels, recurrence, notes, two overdue, a day of due times, two "just added" and two done today; 14 reminders over the five default periods (Early morning finished, Morning under way); 8 quotas (day / week / month, some met) whose prompts are spread over the periods; pre-baked AI insights and What's Next. All invented, generic data — this repo is public.
3. **Serve** — `next start` on port 3353 (`SCREENSHOTS_PORT`) against that database. Stopped on every exit path (`trap`).
4. **Web** — `scripts/screenshots/capture-web.ts` (Playwright, **WebKit**, the apps' engine), light and dark.
5. **Data** — the sample account's API responses (`scripts/dump-preview-data.ts --out <out>/widget-data`, plus today's `/api/completions`), for the native renders. Then the server is stopped.
6. **Native** — `scripts/screenshots/capture-native.sh`: the widget and menu bar renders, then the Apple Watch composite. Skip with `SCREENSHOTS_SKIP_NATIVE=1`.
7. **Manifest** — `scripts/screenshots/finalize.ts` merges each step's `manifest.parts/*.json`.

### The frozen clock

Every run shows the same moment: **Tuesday 2026-09-15, 9:41 AM, America/Chicago** (`OPENTASK_SCREENSHOT_NOW` to change it).

- **Seed and server**: `scripts/screenshots/freeze-clock.cjs`, loaded with `NODE_OPTIONS=--require`, shifts Node's `Date` so "now" starts at that instant (time still moves, so node-cron and elapsed-time guards behave). It does nothing unless `OPENTASK_SCREENSHOT_NOW` is set, and no application code reads it — **there is no app-side clock hook.**
- **Browser**: `page.clock.setFixedTime`, exactly 9:41:00.
- **Why it must stay in the past**: SQLite's `datetime('now')` is the real clock. `src/core/tasks/currently-due.ts` prefilters with it and then filters in JS with the shifted clock, which is correct only while the real date is later.
- **Cookies**: NextAuth's session cookie carries an absolute `Expires` a week after the (shifted) server date, which the browser compares with the real date and drops. `capture-web.ts` routes same-origin responses and strips `Expires` / `Max-Age` from their cookies, so they become session cookies; the JWT inside still expires on the server's clock.
- **AI**: the server runs with `OPENTASK_AI_ENABLED=true` so the AI surfaces render, but the provider is OpenAI with a dummy key and a dead loopback base URL, and `OPENTASK_AI_CLI_PATH` points nowhere, so the Claude Code warm slot fails fast (it logs `Enrichment slot init failed` in `<out>/server.log` — expected). Nothing leaves the machine; what the UI shows is the pre-baked data.

### Web shots

Deterministic by construction: fixed clock, `reducedMotion: 'reduce'`, carets and scrollbars hidden, the pointer parked off the page, and each shot waits for a named element, fonts, no request in flight (the SSE stream excepted) and two painted frames — never a sleep. Locators are roles, labels and the app's data attributes (`task-row-*`, `data-fab-stack`, the "View mode" group, "Just added"), never positions, so layout changes elsewhere don't break a rerun.

The desktop hero (`web-dashboard-full-*` for the docs, `web-dashboard-{theme}-full` / `web-dashboard-{theme}` for the portfolio) is captured at 1600 × 1205 CSS px @2x, wide enough for the dashboard's two columns (tasks left; reminders and quotas right — the `xl` breakpoint is 1450px), then downscaled to the published sizes. Narrower, reminders and quotas fill the first screen and no task shows.

The iPhone app shot (`ios-dashboard-*`) is the dashboard at 402 × 874 @3x (iPhone 16 Pro, 1206 × 2622) with the app's own safe-area padding applied to its `.safe-top` / `.safe-bottom` classes (what WKWebView's insets do in the app) and a 9:41 / full-battery status bar drawn on top. The app is a WKWebView around the same page, so this is what the app shows; it is not a simulator capture (the app's setup needs a server URL and token in the Keychain, which a script can't enter). `ios-dashboard-scrolled-*` is the same screen scrolled so the reminders card sits under the top bar, bringing the quotas and the first task groups into view.

### Widgets and the Mac menu bar

`OpenTaskScreenshotRenders` (in `macos/project.yml`) is a hostless macOS test bundle that compiles the widget extension (`ios/OpenTaskWidgets`, minus its `@main`), `ios/Shared` and the Mac app (minus its `@main`), plus `ios/Tests/Renders/`. Its tests skip unless run by the pipeline, so building it by hand writes nothing. They decode the sample account's JSON with the real DTOs, build entries the way the providers do, and draw the real views:

- **Widgets** (`WidgetRenderTests`): Reminders, Tasks and Quotas at small / medium / large (iPhone 16 Pro sizes, @3x), plus "day complete" for Reminders and Tasks and the Tasks Today page. `ImageRenderer`, with `.buttonStyle(.plain)` so `Link` draws as its label.
- **Menu bar** (`MenuBarRenderTests`): the panel (`MenuBarPanel`, via `NSHostingView` since it holds a text field) and the icon with its overdue badge on a menu-bar strip, @2x.

Two small seams make this possible, both inert in the shipped apps:

- `familyOverride` on `RemindersWidgetView`, `TasksWidgetView` and `TrackWidgetView` — `\.widgetFamily` is get-only and only WidgetKit sets it. Always nil in the extension.
- `MenuBarModel.snapshot(...)`, `#if DEBUG` — a model holding a fixed snapshot instead of polling the server.

`TasksProvider.makeEntry` is internal (was private) so the renderer builds entries exactly as the widget does.

Outside WidgetKit, `containerBackground(for: .widget)` does nothing, so the renderer draws the card: the view's own background (`.fill.tertiary` over white / near-black), the day-complete wash, 16 pt content margins and a 22 pt corner.

**Limit**: these are the **macOS** builds of the views. The few `#if os(iOS)` branches (UIKit line metrics, check-off tap bleed) are the Mac's, and Lock Screen families (macOS has none) aren't drawn. For a pixel-exact iPhone render, the same test file would need an iOS-simulator host (a follow-up, not done).

Derived data goes to `/tmp/dd-shots-mac` and is deleted afterwards (`SCREENSHOTS_KEEP_DERIVED_DATA=1` keeps it for a faster rerun).

### Apple Watch

`scripts/screenshots/capture-watch.ts` composites a watch **screen** capture into the bezel (`opentask-docs/source-assets/apple-watch-frame.png`, override with `SCREENSHOTS_WATCH_FRAME`) and crops it to the docs' 495 × 558. The compositing is automatic; **the screen capture is not**:

- In the watchOS simulator a pushed notification (`xcrun simctl push`) never showed its long look: the app's notification permission can't be granted from the command line (`simctl privacy … notifications` is "Operation not permitted"), and the permission prompt needs a tap.
- `simctl status_bar` doesn't support watchOS, so the clock can't be pinned to 9:41 anyway.
- `ios/AGENTS.md` § Simulator Limitations: watch notification actions need a paired device.

To refresh it: on a paired Apple Watch, get an OpenTask task notification (long look, with Done / +1hr), take a watch screenshot (side button + Digital Crown; it lands in the iPhone's Photos), save it as `<out>/watch-screen.png` (or point `SCREENSHOTS_WATCH_SCREEN` at it) and rerun — or run only this step: `npx tsx scripts/screenshots/capture-watch.ts <out>`. Without a capture the step prints a note and adds nothing to the manifest.

## Where the images go

`manifest.json` / `README.md` in the output directory give each file's destination:

- `docs:<path>` — a path in the **opentask-docs** repo, under `public/images/<type>/` (lowercase kebab-case, light/dark pairs; see that repo's `AGENTS.md` § Images). The downscales it references (`-1040` / `-520` for the desktop dashboard, `-400` / `-200` for the iPhone) are produced alongside. Copy them over there, in that repo, and update the pages that should show them.
- `portfolio:<name>` — the portfolio site's names. The run's `portfolio/` folder holds exactly those files, already named and sized, so staging is a copy: `web-dashboard-light-full.png` (2080 × 1566), `web-dashboard-light.png` (520 × 391), `ios-dashboard-light-full.png` (1206 × 2622), `ios-dashboard-light.png` (400 × 869), and an optional `ios-widget-tasks-light.png` (the Tasks widget, large, when the native step ran). `finalize.ts` checks each size and fails on a mismatch. Dark versions stay in `web/`.

Some files are new (Reminders, Quotas, views, widgets, menu bar) and have no page yet; their destinations are suggestions.

The README's three images (`docs/images/*-readme.png`) are cut from the iPhone and task-card shots by hand; they aren't produced here.

## Adding a shot

- **Web**: in `capture-web.ts`, add to `desktopDashboards`, `desktopPages` or `phoneShots` (each runs once per theme). Wait for a named element with `gotoAndSettle` / `settle`, take `page.screenshot` or `shootWithPadding` for a crop, and `record(file, shows, theme, [destinations])` it. Need different data? Change `seed.ts` — every date there is an offset from the frozen now (`at(days, hour, minute)`).
- **Widget / Mac**: add a `render(...)` call in `ios/Tests/Renders/WidgetRenderTests.swift` (or a new test file there; then `cd macos && xcodegen generate` and commit the project).
- Rerun `npm run screenshots` and look at every new image.

## Prerequisites

- macOS (downscaling uses `sips`; the native step needs Xcode).
- Node deps installed (`npm ci`) and Playwright's WebKit (`npx playwright install webkit`).
- For the native step: Xcode (26+) and `xcodegen`. No simulator, device or signing.
- Port 3353 free (or `SCREENSHOTS_PORT`).
