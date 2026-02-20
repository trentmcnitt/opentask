# Notification Improvements Plan

Tracking document for notification work. See `docs/NOTIFICATIONS.md` for platform reference.

## Architecture

- **Web Push** — primary notification channel for all overdue tasks. Tap opens PWA to the task page.
- **APNs** — iOS native app push via token-based p8 auth. Supports action buttons, time-sensitive interruption level, notification coalescing, and cross-device dismissal.
- **ntfy** — removed. Rate limiting (250 msg/day free tier via ntfy.sh relay) made it unreliable.
- **Pushover** — removed. Replaced by APNs time-sensitive interruption level for P4 tasks.

## 1. Web Push

- [x] Generate VAPID keys, store server-side
- [x] Add push subscription endpoint (`POST /api/push/subscribe`)
- [x] Store push subscriptions per user in the database
- [x] Extend `public/sw.js` with `push` and `notificationclick` handlers
- [x] Send a test notification with task data in `notification.data`
- [x] Wire overdue checker to send via Web Push (replaced ntfy)
- [x] Add VAPID keys to production systemd service override

### Key constraints (iOS Safari)

- No action buttons — silently ignored
- No `tag` replacement — broken, stacks instead of replacing (open WebKit bug)
- No `icon` — always shows PWA icon
- No silent push — every push must show a notification
- `notification.data` works on iOS 18+
- `notification.close()` works on iOS 18.3+

## 2. iOS Native App (APNs)

- [x] `apns2` npm package for server-side APNs delivery
- [x] WKWebView shell with Notification Content Extension
- [x] Interactive snooze grid (4x3 with presets, increments, decrements)
- [x] Action buttons: Done, +1hr, All +1hr (with dynamic labels from grid)
- [x] Time-sensitive interruption level for P3/P4 tasks
- [x] Notification coalescing via `collapseId`
- [x] Cross-device dismissal via silent push
- [x] TestFlight build uploaded

## 3. Future improvements

### Fix notification timing

Current system polls every ~60 seconds and discovers overdue tasks after the fact. Tasks due at 10:00 aren't noticed until ~10:01.

- [ ] Pre-schedule notifications at exact `due_at` time (needs research — server-side scheduling via setTimeout or priority queue)
- [ ] Keep the 1-minute poll as a safety net for anything that fell through

### Web Push action page

Web Push on iOS doesn't support action buttons, but the notification tap can open a quick-action page in the PWA.

- [ ] Build a quick-action landing page that the notification opens to
- [ ] Page shows task title + Done/Snooze/Details buttons
- [ ] Test that `notificationclick` reliably navigates to the correct URL on iOS
