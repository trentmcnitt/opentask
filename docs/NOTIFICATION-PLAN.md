# Notification Improvements Plan

Tracking document for notification work. See `docs/NOTIFICATIONS.md` for platform reference.

## Architecture

- **Web Push** — primary notification channel for all overdue tasks. Tap opens PWA to the task page.
- **Pushover** — critical alerts only (emergency priority with retry). Bypasses Focus/DND but opens Pushover app, not PWA.
- **ntfy** — removed. Rate limiting (250 msg/day free tier via ntfy.sh relay) made it unreliable.

## 1. Web Push

- [x] Generate VAPID keys, store server-side
- [x] Add push subscription endpoint (`POST /api/push/subscribe`)
- [x] Store push subscriptions per user in the database
- [x] Extend `public/sw.js` with `push` and `notificationclick` handlers
- [x] Send a test notification with task data in `notification.data`
- [x] Wire overdue checker to send via Web Push (replaced ntfy)
- [x] Wire critical alerts to send via Web Push (alongside Pushover)
- [ ] Verify on iOS: tap opens PWA to the correct task page
- [ ] Verify `notification.data` passes through on iOS 18+
- [ ] Test `fetch()` reliability in `notificationclick` handler on iOS
- [ ] Build a quick-action landing page (mini QuickActionPanel) that the notification opens to
- [ ] Test Declarative Web Push (`navigate` field) for iOS 18.4+
- [ ] Add VAPID keys to production systemd service override

### Key constraints (iOS Safari)

- No action buttons — silently ignored
- No `tag` replacement — broken, stacks instead of replacing (open WebKit bug)
- No `icon` — always shows PWA icon
- No silent push — every push must show a notification
- `notification.data` works on iOS 18+
- `notification.close()` works on iOS 18.3+

## 2. Pushover (critical alerts only)

- [x] Wire Pushover for P4 (Urgent) task alerts (emergency priority)
- [x] Add `url` and `url_title` params to Pushover payloads
- [ ] Create Pushover application — upload 128x128 PNG icon
- [ ] Set `PUSHOVER_TOKEN` env var on dev and prod
- [ ] Add `sound` parameter — different sound for critical
- [ ] Store Pushover receipt IDs for emergency notifications so we can cancel retry when task is completed

## 3. Fix notification timing

Current system polls every ~60 seconds and discovers overdue tasks after the fact. Tasks due at 10:00 aren't noticed until ~10:01.

- [ ] Pre-schedule notifications at exact `due_at` time (needs research — server-side scheduling via setTimeout or priority queue)
- [ ] Keep the 1-minute poll as a safety net for anything that fell through

## 4. Notification action button tuning (Web Push)

Web Push on iOS doesn't support action buttons, but the notification tap can open a quick-action page in the PWA.

- [ ] Build a quick-action landing page that the notification opens to
- [ ] Page shows task title + Done/Snooze/Details buttons
- [ ] Test that `notificationclick` reliably navigates to the correct URL on iOS

## 5. Future: Native iOS app

Not immediate. Revisit after living with the improved Web Push + Pushover setup.

- Full APNs control: 4 action buttons, thread-id grouping, Time Sensitive interruption level, notification dismissal sync
- Thin shell using Hotwire Native or plain Swift + WKWebView
- $99/year Apple Developer Program, Ad Hoc distribution for 2 devices
- Each self-hosted user who wants the native app needs their own paid Apple Developer account and must upload their APNs key to the server
- Critical Alerts entitlement requires Apple approval regardless of distribution method — unlikely to be granted for a task app
