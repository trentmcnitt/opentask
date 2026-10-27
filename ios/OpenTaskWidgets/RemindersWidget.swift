import SwiftUI
import WidgetKit

// MARK: - Entry

struct RemindersEntry: TimelineEntry {
    let date: Date
    let groups: [ReminderGroupDTO]
    /// Today's LISTED task segments (2026-10-10; `TaskSegmentDTO.listed`,
    /// after the pending filters), in screen order — the pages that come
    /// AFTER the time slots in the widget's ring. Never merged into
    /// `groups`: no PERIOD's count ("N left", "N of M") reads them
    /// (amendment 8); since 2026-10-11 they have their own strip bars and
    /// "X of Y", and a waiting one keeps the day from being complete
    /// (`ReminderDayProgress`). No default, so every construction site says
    /// what it shows.
    let segments: [TaskSegmentDTO]
    /// Index into `groups`. Never out of range — the provider clamps. While a
    /// segment page is on screen this is the clock's natural slot, which the
    /// slot-only families (2×2, Lock Screen) keep showing.
    let slotIndex: Int
    /// Non-nil while a task segment page is on screen: an index into
    /// `segments`.
    let segmentIndex: Int?
    /// Non-nil when this entry was rendered from the App Group cache because a
    /// fetch failed. Drives the "as of HH:MM" note.
    let staleSince: Date?
    /// No server URL / token in the Keychain — the app has not been set up.
    let isSignedOut: Bool
    /// Whether the header's Undo/Redo buttons should be enabled at THIS
    /// entry's `date` — see `WidgetStore.canUndo`/`canRedo` and
    /// `UndoRedoButtons`. Not time-windowed (2026-09-23): these simply carry
    /// forward whatever the server's own counts were when the entry was
    /// built, the same limitation `staleSince` already accepts for a
    /// pre-scheduled future entry.
    let canUndo: Bool
    let canRedo: Bool
    /// The header subtitle's "Undid: …" / "Redid: …" indication, live for
    /// `WidgetStore.lastActionWindow` seconds after an undo/redo — see
    /// `WidgetStore.lastActionDescription(at:)`. `nil` shows the ordinary
    /// count subtitle instead.
    let actionDescription: String?

    var group: ReminderGroupDTO? {
        guard groups.indices.contains(slotIndex) else { return nil }
        return groups[slotIndex]
    }

    /// The task segment on screen, or nil on a slot page.
    var segment: TaskSegmentDTO? {
        guard let segmentIndex, segments.indices.contains(segmentIndex) else { return nil }
        return segments[segmentIndex]
    }
}

// MARK: - Provider

struct RemindersProvider: TimelineProvider {

    /// How often to refresh when nothing else forces it. Well inside the
    /// ~40-70 reloads/day the system allows, and every check-off reloads for
    /// free on top of this.
    private static let refreshInterval: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> RemindersEntry {
        SampleData.remindersEntry
    }

    func getSnapshot(in context: Context, completion: @escaping (RemindersEntry) -> Void) {
        // The widget gallery must never show an empty or half-loaded card, and
        // it gets no chance to await a network call.
        if context.isPreview {
            completion(SampleData.remindersEntry)
            return
        }
        Task { completion(await currentEntry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RemindersEntry>) -> Void) {
        Task {
            // A widget push token the server never confirmed — see
            // `WidgetPushRegistration` in ios/Shared.
            await WidgetPushRegistration.widgets.retryIfNeeded()
            let entry = await currentEntry()

            var entries = [entry]
            if !entry.isSignedOut {
                // Boundary entries re-run the default-page rule at each
                // period's opening (Trent's ruling 10-27, rule 4: when the
                // next period opens with something waiting, the widget goes
                // back to it — periods sit left of the queue). A manual flip
                // is kept only while it would still hold there: its anchor
                // is the default page at that moment, so an opening that
                // moves the default drops it, and one that doesn't (the
                // period has nothing waiting, Deadlines still unseen) leaves
                // it on screen (`scheduledPage`).
                let override = WidgetStore.slotOverride()
                for boundary in RemindersTimeline.upcomingBoundaries(in: entry.groups, now: entry.date).prefix(8) {
                    let page = RemindersTimeline.scheduledPage(
                        groups: entry.groups, segments: entry.segments, now: boundary.date, override: override
                    )
                    entries.append(
                        RemindersEntry(
                            date: boundary.date,
                            groups: entry.groups,
                            segments: entry.segments,
                            slotIndex: page.slotIndex,
                            segmentIndex: page.segmentIndex,
                            staleSince: entry.staleSince,
                            isSignedOut: false,
                            canUndo: entry.canUndo,
                            canRedo: entry.canRedo,
                            actionDescription: WidgetStore.lastActionDescription(at: boundary.date)
                        )
                    )
                }
                // The explicit "Undid: …" expiry (2026-09-23) — WidgetKit has
                // no "expire after N seconds" primitive, only entries dated
                // for a specific moment, so the guaranteed-off state needs
                // its own entry rather than something inferred between
                // reloads. Guarded by `expiry > entry.date`: a live
                // `actionDescription` on the primary entry already implies
                // this, but stated explicitly so a future reordering of
                // these blocks can't schedule an entry dated at or before
                // `now`.
                if entry.actionDescription != nil, let expiry = WidgetStore.lastActionExpiry(),
                    expiry > entry.date {
                    // Which page should still be on screen once the
                    // indication turns off: whichever entry built above is
                    // dated latest at or before `expiry` — almost always
                    // `entry` itself, but if a slot boundary happens to fall
                    // inside this 60s window, that boundary's NATURAL page is
                    // what should still be showing at expiry. Deliberately
                    // NOT `RemindersTimeline.displayedPage(now: expiry)`
                    // — that has the side effect of clearing a stale
                    // override, which must only happen against the REAL
                    // clock, not a hypothetical future timestamp being
                    // pre-computed here.
                    let atExpiry = entries.filter { $0.date <= expiry }.max { $0.date < $1.date } ?? entry
                    entries.append(
                        RemindersEntry(
                            date: expiry,
                            groups: entry.groups,
                            segments: entry.segments,
                            slotIndex: atExpiry.slotIndex,
                            segmentIndex: atExpiry.segmentIndex,
                            staleSince: entry.staleSince,
                            isSignedOut: false,
                            canUndo: entry.canUndo,
                            canRedo: entry.canRedo,
                            actionDescription: nil
                        )
                    )
                }
            }
            entries.sort { $0.date < $1.date }

            // Reload no later than the day start ("Day starts at" PR 3): the
            // new day's roster and prompt keys are a fetch away, and a key
            // from before the day turned is refused. The server's rollover
            // sync push asks for the same reload; this is the budget-free
            // backstop.
            let next = min(
                Date().addingTimeInterval(Self.refreshInterval),
                DayStartStore.current.nextRollover(after: entry.date)
            )
            completion(Timeline(entries: entries, policy: .after(next)))
            // Only AFTER the timeline is handed over — never between a tap and
            // its repaint. Every reload is a chance to send what a tap queued
            // (a scheduled refresh or a push is the retry path; see
            // `WidgetOutboxDrainer`).
            kickWidgetOutbox()
        }
    }

    /// An entry for `now` showing `groups`/`segments` as they will be drawn:
    /// every optimistic marker applied, segments narrowed to the listed ones,
    /// on the displayed page.
    private func entry(
        now: Date, groups rawGroups: [ReminderGroupDTO], segments rawSegments: [TaskSegmentDTO], staleSince: Date?
    ) -> RemindersEntry {
        let groups = WidgetStore.filterPending(rawGroups, now: now)
        let segments = TaskSegmentDTO.listed(WidgetStore.filterPendingSegments(rawSegments, now: now))
        let page = RemindersTimeline.displayedPage(groups: groups, segments: segments, now: now)
        return RemindersEntry(
            date: now,
            groups: groups,
            segments: segments,
            slotIndex: page.slotIndex,
            segmentIndex: page.segmentIndex,
            staleSince: staleSince,
            isSignedOut: false,
            canUndo: WidgetStore.canUndo,
            canRedo: WidgetStore.canRedo,
            actionDescription: WidgetStore.lastActionDescription(at: now)
        )
    }

    /// Fetch, falling back to the App Group cache. Never throws to the caller —
    /// a widget's only honest failure modes are "signed out" and "stale".
    private func currentEntry() async -> RemindersEntry {
        let now = Date()

        guard APIClient.shared.isConfigured else {
            return RemindersEntry(
                date: now, groups: [], segments: [], slotIndex: 0, segmentIndex: nil, staleSince: nil,
                isSignedOut: true, canUndo: false, canRedo: false, actionDescription: nil
            )
        }

        // Interaction fast path (§8 optimistic check-off): a tap just happened,
        // so repaint from cache immediately — the tombstone filter is what makes
        // the checked item vanish NOW instead of after a seconds-long fetch.
        // No staleness note: this data is seconds old by construction. Also
        // gated on no intent having declared this cache stale since
        // (2026-09-24) — see `WidgetStore.canRepaintRemindersFromCache`.
        if WidgetStore.canRepaintRemindersFromCache(now: now), let cached = WidgetStore.loadReminders() {
            return entry(now: now, groups: cached.value.groups, segments: cached.value.taskSegments, staleSince: nil)
        }

        do {
            // Concurrent with the reminders fetch — piggybacked undo/redo
            // counts (2026-09-23) so the always-present buttons reflect the
            // server even when the last change came from the web app or
            // another device. Best-effort: `try?` so a flaky
            // `/api/undo/status` never fails the reminders fetch it rides
            // along with.
            async let reminders = APIClient.shared.fetchReminders()
            async let undoStatus: APIClient.UndoStatus? = try? APIClient.shared.fetchUndoStatus()
            let (payload, status) = try await (reminders, undoStatus)
            WidgetStore.saveReminders(payload.groups, taskSegments: payload.taskSegments, fetchStartedAt: now)
            if let status {
                // The counts and, scoped (2026-10-26), the ids `UndoScope` compares
                // its own stack with — applied only if sent after the last tap.
                WidgetStore.applyUndoStatus(status, requestedAt: now)
            }
            // Filter even the fresh fetch: a tombstoned completion may not have
            // committed server-side yet, and resurrecting it for one refresh
            // cycle would look like the check-off didn't take.
            return entry(now: now, groups: payload.groups, segments: payload.taskSegments, staleSince: nil)
        } catch {
            print("[OpenTaskWidgets] Reminders fetch failed: \(error)")
            let cached = WidgetStore.loadReminders()
            return entry(
                now: now, groups: cached?.value.groups ?? [], segments: cached?.value.taskSegments ?? [],
                staleSince: cached?.fetchedAt
            )
        }
    }
}

// MARK: - Widget

struct RemindersWidget: Widget {
    static let kind = "OpenTaskReminders"

    var body: some WidgetConfiguration {
        // Server-pushed reloads (iOS 26 / macOS 26 — see WidgetPushHandler.swift
        // and docs/NOTIFICATIONS.md § WidgetKit push) need `.pushHandler(...)`,
        // gated here rather than raising this extension's deployment target
        // (iOS 17 / macOS 14). See the doc comment in TasksWidget.swift for why
        // this needs an EXPLICIT `return` in each branch (implicit return, or
        // an `if` that isn't the body's sole statement, both fail to compile —
        // `Widget.body` has no result builder to reconcile the two branches'
        // different concrete types).
        if #available(iOS 26.0, macOS 26.0, *) {
            return StaticConfiguration(kind: Self.kind, provider: RemindersProvider()) { entry in
                RemindersWidgetView(entry: entry)
            }
            .configurationDisplayName("Reminders")
            .description("The current time slot's reminders, with tap-to-check-off.")
            // systemLarge first: it is the primary layout (§8 — the user pointed
            // at a 4x4 Weather widget), and the gallery leads with the first entry.
            // .accessoryRectangular / .accessoryCircular are Lock Screen families,
            // @available(macOS, unavailable) — hard compile errors on native macOS
            // (unlike the Designed-for-iPad build, which the plain iOS SDK compile
            // didn't reject). Lock Screen accessories simply don't exist on the Mac.
            //
            // Built with an immediately-invoked closure rather than #if inside the
            // array literal itself — the compiler rejects #if/#endif as array
            // *elements* ("expected expression in container literal"), even though
            // #if is fine as a statement inside a closure body.
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemLarge, .systemMedium, .systemSmall]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
            .pushHandler(OpenTaskWidgetPushHandler.self)
        } else {
            return StaticConfiguration(kind: Self.kind, provider: RemindersProvider()) { entry in
                RemindersWidgetView(entry: entry)
            }
            .configurationDisplayName("Reminders")
            .description("The current time slot's reminders, with tap-to-check-off.")
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemLarge, .systemMedium, .systemSmall]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
        }
    }
}

#if DEBUG
// MARK: - Previews (2026-09-24, realistic sample data)
//
// Realistic sample reminders with the shape of a real account at 8:44 AM
// on the day the list-fill bug was reported ("Early morning · 7 left", page
// 1/4 showing only two rows — the bug these previews exist to reproduce):
// the same slots, row counts and title lengths, including one
// paragraph-length reminder, because the fill bug only shows up with
// realistic title lengths and a tidy short corpus is exactly what let it
// ship. The titles are invented. Deliberately NOT `SampleData.swift`, which
// ships in the app bundle and backs the real widget gallery/placeholder —
// these previews are `#if DEBUG`-only and never ship. With
// `ios/Previews.local/reminders.json` present (`PreviewLocalData`,
// gitignored) they render that account data instead.
//
// ONE #Preview BLOCK PER STORE STATE (page, "show completed"), not several
// timeline entries in one: the page index and the toggle are read live from
// the App Group at RENDER time, and a `timeline:` closure's entries are all
// built before any of them renders — so a store write made while building
// one shared timeline would apply to every entry in it.
private enum ReminderPreviewData {
    /// The sample's clock: 8:44 AM local today — inside Early morning
    /// (07:00-09:00), where Trent's screenshots were taken.
    static var now: Date {
        Calendar.current.date(bySettingHour: 8, minute: 44, second: 0, of: Date()) ?? Date()
    }

    private static func group(
        _ id: Int, _ label: String, _ start: String, _ reminders: [TaskDTO], considered: [TaskDTO],
        prompts: [QuotaPromptDTO] = []
    ) -> ReminderGroupDTO {
        ReminderGroupDTO(
            slot: TimeSlotDTO(id: id, label: label, startTime: start),
            reminders: reminders,
            considered: considered.count,
            consideredItems: considered,
            prompts: prompts
        )
    }

    /// One quota prompt as the server sends it (quota reminders,
    /// 2026-09-24). Keyed for the sample's day; previews never send it.
    private static func prompt(
        _ taskId: Int, _ number: Int?, _ title: String, _ current: Int, _ target: Int,
        _ period: String?, _ stripe: String?, considered: Bool = false, done: Bool = false,
        ends: String? = nil
    ) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: "q:\(taskId):\(number ?? 0):2026-09-24", taskId: taskId, number: number,
            title: title, current: current, target: target, period: period, stripeColor: stripe,
            considered: considered, done: done, hasNotes: false,
            periodInterval: ends == nil ? 1 : 2, periodLabel: ends
        )
    }

    /// Sample quota prompts (2026-09-24): Early morning is the period
    /// every unmet quota prompts in by default, so it holds sixteen — the
    /// layout stress case, a slot that is mostly prompt rows, with the
    /// longest titles ("Look for new evening courses — …", "Posture practice
    /// (…)"). Piano Scales is daily with target 2, so its #1 is here and its
    /// #2 is in Morning.
    static var earlyMorningPrompts: [QuotaPromptDTO] {
        [
            prompt(116, nil, "Oatmeal + Berries", 1, 3, "WEEKLY", nil),
            prompt(3307, nil, "Look for new evening courses — community colleges, library programs, weekend workshops", 0, 1, "WEEKLY", "pink"),
            prompt(276, nil, "Vacuum the car mats", 0, 1, "MONTHLY", "purple"),
            // An interval quota (2026-10-16): its end, not "week".
            prompt(24001, nil, "Deep-clean the oven", 0, 1, "WEEKLY", "orange", ends: "by Oct 24"),
            prompt(255, nil, "Bake bread from scratch (incl. sourdough)", 0, 5, "WEEKLY", "blue"),
            prompt(83, 1, "Piano Scales", 0, 2, "DAILY", "blue"),
            prompt(193, nil, "Figs", 1, 2, "WEEKLY", nil),
            prompt(129, nil, "Whole grains (ie brown rice)", 1, 3, "WEEKLY", nil),
            prompt(192, nil, "Sort the recycling (chore)", 0, 5, "WEEKLY", "purple"),
            prompt(21400, nil, "Citrus Snack (e.g. oranges, clementines)", 0, 2, "WEEKLY", nil),
            prompt(163, nil, "Posture practice (tall spine, soft jaw, shoulders down and back, feet flat on the floor, seated)", 0, 4, "WEEKLY", "blue"),
            prompt(239, nil, "Home-cooked soup (ie minestrone)", 0, 2, "WEEKLY", nil),
            prompt(258, nil, "Green smoothie (+ginger)", 0, 2, "WEEKLY", "blue"),
            prompt(132, nil, "Evening tea ( Chamomile, Peppermint )", 1, 3, "WEEKLY", "blue"),
            prompt(13, nil, "Bike ride (+neighbors)", 1, 4, "WEEKLY", nil),
            prompt(118, nil, "Guitar class", 1, 2, "WEEKLY", nil),
            prompt(160, nil, "Yogurt parfait", 1, 3, "WEEKLY", nil),
        ]
    }

    /// Every slot of the day, as `GET /api/reminders` returns them at 8:44 —
    /// or the local account data, when there is some.
    static var groups: [ReminderGroupDTO] {
        PreviewLocalData.reminderGroups ?? [
            group(11, "Early morning", "07:00", [
                TaskDTO(id: 604, title: "Breakfast ( Oatmeal, Berries, Walnuts )", priority: 2, isReminder: true),
                TaskDTO(id: 64, title: "Practice the new song slowly, one phrase at a time, noticing where the breath runs short and marking it on the sheet before trying the whole verse again. Then play it once through without stopping, record it, and listen back with fresh ears. (Small daily corrections add up faster than one long weekend session.)", priority: 0, isReminder: true),
                TaskDTO(id: 168, title: "Plant care (Water, Mist, Turn to sun)", priority: 0, isReminder: true),
                TaskDTO(id: 208, title: "Treat each mistake as a clue to what’s worth learning?", priority: 0, isReminder: true),
                TaskDTO(id: 218, title: "A calm start to the morning sets up the rest of it", priority: 0, isReminder: true),
                TaskDTO(id: 223, title: "Sit tall at the desk and let the shoulders drop and relax", priority: 0, isReminder: true),
                TaskDTO(id: 23432, title: "Open blinds (morning)", priority: 0, isReminder: true),
            ], considered: [
                TaskDTO(id: 24, title: "Morning = Focus, Afternoon = Meetings, Evening = Rest", priority: 0, isReminder: true),
            ], prompts: earlyMorningPrompts),
            group(12, "Morning", "09:00", [
                TaskDTO(id: 2226, title: "Check the team inbox", priority: 2, isReminder: true),
                TaskDTO(id: 126, title: "Do my stretches", priority: 0, isReminder: true),
                TaskDTO(id: 183, title: "Carrot Sticks + Hummus Cup", priority: 0, isReminder: true),
                TaskDTO(id: 197, title: "Deep breath (Slow in, hold it gently — good for steady focus)", priority: 0, isReminder: true),
                TaskDTO(id: 215, title: "Calf raises", priority: 0, isReminder: true),
                TaskDTO(id: 18050, title: "How has the new morning routine felt (calm and useful to start the day?)", priority: 0, isReminder: true),
            ], considered: [
            ], prompts: [prompt(83, 2, "Piano Scales", 0, 2, "DAILY", "blue")]),
            group(13, "Midday", "12:00", [
                TaskDTO(id: 2247, title: "Check the community board posts", priority: 2, isReminder: true),
                TaskDTO(id: 38, title: "Is the new plant food still working", priority: 0, isReminder: true),
                TaskDTO(id: 146, title: "Crossword puzzle time", priority: 0, isReminder: true),
                TaskDTO(id: 279, title: "Raisins", priority: 0, isReminder: true),
                TaskDTO(id: 23393, title: "Refill water (optional)", priority: 0, isReminder: true),
            ], considered: [
            ]),
            group(14, "Afternoon", "16:00", [
                TaskDTO(id: 12, title: "Listening fully is a much kinder way to talk/be", priority: 0, isReminder: true),
                TaskDTO(id: 127, title: "Remember to notice the day (“what did I notice today?”, “what am I going to look for tomorrow?”)", priority: 0, isReminder: true),
                TaskDTO(id: 150, title: "Make sure there is a group hike or an outdoor weekend activity on the family calendar", priority: 0, isReminder: true),
                TaskDTO(id: 222, title: "“Take care of the minutes, and the hours will take care of themselves.”", priority: 0, isReminder: true),
            ], considered: [
            ]),
            group(15, "Evening", "20:30", [
                TaskDTO(id: 41, title: "Pack lunches", priority: 0, isReminder: true),
                TaskDTO(id: 44, title: "A short walk after dinner might help settle the mind at night", priority: 0, isReminder: true),
                TaskDTO(id: 70, title: "Box breathing to wind down (use timer)", priority: 0, isReminder: true),
                TaskDTO(id: 94, title: "Hip stretch (desk day)", priority: 0, isReminder: true),
                TaskDTO(id: 136, title: "Fill the house with good music and curious people. Borrow books, try new recipes, play board games — whatever keeps it lively. Provides learning + a steady source of calm", priority: 0, isReminder: true),
                TaskDTO(id: 273, title: "Evening wind-down routine (after dishes) (finish with a warm drink)", priority: 0, isReminder: true),
                TaskDTO(id: 3093, title: "Ask myself: “What can I let go of?”", priority: 0, isReminder: true),
            ], considered: [
            ]),
        ]
    }

    /// Early morning's slot key — the on-screen slot, and what the stored
    /// page index is paired with (`WidgetStore.remindersPage(for:)`).
    static var earlyMorningKey: Int { groups.first?.slot?.id ?? 11 }

    /// 4:30 PM — Afternoon is live, three periods behind it, Evening still
    /// to come: the strip's started/faded split (2026-09-28) on one card.
    static var afternoon: Date {
        Calendar.current.date(bySettingHour: 16, minute: 30, second: 0, of: Date()) ?? Date()
    }

    static func entry(slotIndex: Int = 0, at date: Date? = nil) -> RemindersEntry {
        RemindersEntry(
            date: date ?? now,
            groups: groups, segments: [],
            slotIndex: slotIndex, segmentIndex: nil,
            staleSince: nil,
            isSignedOut: false,
            canUndo: true,
            canRedo: false,
            actionDescription: nil
        )
    }

    /// 4:30 PM with Evening (20:30, not started yet) already finished — a
    /// period done EARLY draws green, not a gray placeholder (2026-09-28).
    static func eveningDoneEarlyEntry() -> RemindersEntry {
        var gs = groups
        let i = eveningIndex
        let g = gs[i]
        gs[i] = ReminderGroupDTO(
            slot: g.slot, reminders: [], considered: g.considered + g.reminders.count,
            consideredItems: g.consideredItems + g.reminders, prompts: g.prompts.map { $0.handled(did: false) }
        )
        return RemindersEntry(
            date: afternoon, groups: gs, segments: [], slotIndex: 3, segmentIndex: nil, staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    /// `entry()` with Early morning's first reminder (Breakfast) gone,
    /// so the paragraph-long one is `reminders[0]`.
    static func paragraphFirstEntry() -> RemindersEntry {
        var gs = groups
        let g = gs[0]
        gs[0] = ReminderGroupDTO(
            slot: g.slot,
            reminders: Array(g.reminders.dropFirst()), considered: g.considered, consideredItems: g.consideredItems,
            prompts: g.prompts
        )
        return RemindersEntry(
            date: now, groups: gs, segments: [], slotIndex: 0, segmentIndex: nil, staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    /// Early morning with three prompts handled today — Piano Scales #1 did
    /// (1/2), Oatmeal + Berries considered, Figs did (2/2) — for the DONE
    /// section's prompt rows (each marker a put-back, 2026-09-25).
    static func promptsHandledEntry() -> RemindersEntry {
        var gs = groups
        let g = gs[0]
        let handled: [String: Bool] = ["q:83:1:2026-09-24": true, "q:116:0:2026-09-24": false, "q:193:0:2026-09-24": true]
        gs[0] = g.replacingPrompts(g.prompts.map { p in handled[p.promptKey].map { p.handled(did: $0) } ?? p })
        return RemindersEntry(
            date: now, groups: gs, segments: [], slotIndex: 0, segmentIndex: nil, staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    /// Early morning with every REMINDER considered — only its prompts wait,
    /// so the 2×2 and Lock Screen lead with a prompt.
    static func promptsOnlyEntry() -> RemindersEntry {
        var gs = groups
        let g = gs[0]
        gs[0] = ReminderGroupDTO(
            slot: g.slot, reminders: [], considered: g.considered + g.reminders.count,
            consideredItems: g.reminders + g.consideredItems, prompts: g.prompts
        )
        return RemindersEntry(
            date: now, groups: gs, segments: [], slotIndex: 0, segmentIndex: nil, staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    /// Pins the page and the toggle — previews share the simulator's App
    /// Group UserDefaults, so whatever a prior preview (or a real widget)
    /// left there would otherwise bleed into this render.
    /// `dayStart`: the remembered day boundary the preview draws with — the
    /// Upcoming previews pass 3:00 AM for the night words (2026-10-26).
    static func prepare(
        page: Int, showCompleted: Bool, slotKey: Int = earlyMorningKey,
        dayStart: String = OpenTaskDay.calendarDayStart
    ) {
        DayStartStore.seedForPreview(dayStart)
        WidgetStore.setShowCompleted(showCompleted, for: RemindersWidget.kind)
        WidgetStore.setRemindersPage(page, for: slotKey)
    }

    /// Evening — the slot with the other paragraph-length reminder ("Fill
    /// the house with good music and curious people…"). Clamped, so local
    /// data with fewer slots still renders.
    static var eveningIndex: Int { max(0, min(4, groups.count - 1)) }
    static var eveningKey: Int { groups[eveningIndex].slot?.id ?? -1 }

    // MARK: Task segments (2026-10-10) — invented titles, a real day's shape:
    // a "Days" segment with a mix of set and unset horizons, a deadline, a
    // future target, one long title, and one row already considered.

    private static func iso(daysFromNow days: Int, hour: Int = 9) -> String {
        let day = Calendar.current.date(byAdding: .day, value: days, to: now) ?? now
        let at = Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
        return DateHelpers.formatISO(at)
    }

    /// Upcoming's Tomorrow section (2026-10-26): tomorrow afternoon, and
    /// 1:00 AM after tomorrow's date — tomorrow NIGHT's with a 3:00 AM day
    /// start ("tomorrow night 1:00 am").
    static var upcomingTomorrow: [SegmentTaskDTO] {
        [
            SegmentTaskDTO(task: TaskDTO(id: 9307, title: "Pick up the framed print from the shop", dueAt: iso(daysFromNow: 1, hour: 15)), state: .waiting, recurring: false, upcomingSection: .tomorrow),
            SegmentTaskDTO(task: TaskDTO(id: 9309, title: "Catch the early airport shuttle", dueAt: iso(daysFromNow: 2, hour: 1), deadlineAt: iso(daysFromNow: 2, hour: 2)), state: .waiting, recurring: false, upcomingSection: .tomorrow),
        ]
    }

    /// Upcoming's Later section: the #251 review set, and one row already
    /// considered today ("Later  1 of 8").
    static var upcomingLater: [SegmentTaskDTO] {
        [
            SegmentTaskDTO(task: TaskDTO(id: 9301, title: "Call the insurance office about the renewal paperwork for the car", priority: 2, dueAt: iso(daysFromNow: 2), deadlineAt: iso(daysFromNow: 5, hour: 17), horizon: "weeks"), state: .waiting, recurring: false, upcomingSection: .later),
            SegmentTaskDTO(task: TaskDTO(id: 9302, title: "Water the porch plants", dueAt: iso(daysFromNow: 2), rrule: "FREQ=WEEKLY;BYDAY=WE", anchorTime: "09:00"), state: .waiting, recurring: true, upcomingSection: .later),
            SegmentTaskDTO(task: TaskDTO(id: 9303, title: "Take the recycling and the yard waste bins out to the curb", dueAt: iso(daysFromNow: 2, hour: 7), rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE", anchorTime: "07:00"), state: .waiting, recurring: true, upcomingSection: .later),
            SegmentTaskDTO(task: TaskDTO(id: 9304, title: "Send the signed lease renewal back to the property manager", dueAt: iso(daysFromNow: 3), deadlineAt: iso(daysFromNow: 6, hour: 17), attempts: 3, attemptsLabel: "3×"), state: .waiting, recurring: false, upcomingSection: .later),
            SegmentTaskDTO(task: TaskDTO(id: 9305, title: "Pay the water bill", dueAt: iso(daysFromNow: 20, hour: 12), rrule: "FREQ=MONTHLY;BYMONTHDAY=1", anchorTime: "12:00"), state: .waiting, recurring: true, upcomingSection: .later),
            SegmentTaskDTO(task: TaskDTO(id: 9306, title: "Book the follow-up appointment once the clinic posts November's schedule", dueAt: iso(daysFromNow: 4), deadlineAt: iso(daysFromNow: -1, hour: 17)), state: .waiting, recurring: false, upcomingSection: .later),
            SegmentTaskDTO(task: TaskDTO(id: 9308, title: "Drop the donation boxes at the community center on the way to work", dueAt: iso(daysFromNow: 6), deadlineAt: iso(daysFromNow: 9, hour: 17)), state: .waiting, recurring: false, upcomingSection: .later),
            SegmentTaskDTO(task: TaskDTO(id: 9310, title: "Renew the car registration", dueAt: iso(daysFromNow: 5)), state: .considered, recurring: false, upcomingSection: .later),
        ]
    }

    static var segments: [TaskSegmentDTO] {
        PreviewLocalData.taskSegments ?? [
            TaskSegmentDTO(horizon: "days", tasks: [
                SegmentTaskDTO(task: TaskDTO(id: 9101, title: "Call the insurance office about the renewal letter", priority: 3, horizon: "days"), state: .waiting),
                SegmentTaskDTO(task: TaskDTO(id: 9102, title: "Fix the squeaky gate hinge", priority: 2, dueAt: iso(daysFromNow: 3), deadlineAt: iso(daysFromNow: 6, hour: 17), horizon: "days"), state: .waiting),
                SegmentTaskDTO(task: TaskDTO(id: 9103, title: "Order the replacement filter for the kitchen tap", priority: 1), state: .waiting),
                SegmentTaskDTO(task: TaskDTO(id: 9104, title: "Book the dentist for the kids — ask about the Saturday morning slots before the school term starts again", hasNotes: true, horizon: "weeks"), state: .waiting),
                SegmentTaskDTO(task: TaskDTO(id: 9105, title: "Return the library books", dueAt: iso(daysFromNow: 22), horizon: "days"), state: .considered),
            ]),
            // Upcoming (2026-10-12), after Days as the server sends it —
            // the #251 review set, long titles included: one-offs with a
            // deadline (one wearing "3×"), repeating tasks whose schedule
            // has to shorten to fit one line (weekly at a time, every 2
            // weeks on a day at a time, monthly on the 1st), a deadline
            // before its target, and a plain target. Every row offers
            // Target today, the repeating ones too. Since 2026-10-26 in its
            // two sections, Tomorrow's rows first as the server sends them:
            // tomorrow afternoon, and 1:00 AM after tomorrow's date (tomorrow
            // NIGHT's, with a 3:00 AM day start); one Later row considered.
            TaskSegmentDTO(horizon: "upcoming", tasks: upcomingTomorrow + upcomingLater),
            TaskSegmentDTO(horizon: "weeks", tasks: [
                // Undated and past its horizon's threshold: the age label (the
                // server's `age_label`).
                SegmentTaskDTO(task: TaskDTO(id: 9201, title: "Clear out the garage shelves", horizon: "weeks", ageLabel: ">1 mo"), state: .waiting),
                SegmentTaskDTO(task: TaskDTO(id: 9202, title: "Research a new laptop bag", dueAt: iso(daysFromNow: 12), horizon: "months"), state: .waiting),
            ]),
            // The longest title word ("Task queue · Quarterly", 2026-10-26),
            // for the header's two-line fallback at XXX Large.
            TaskSegmentDTO(horizon: "eventually", tasks: [
                SegmentTaskDTO(task: TaskDTO(id: 9401, title: "Sort the old photo albums", horizon: "eventually"), state: .waiting),
            ]),
        ]
    }

    /// The page `key` names, with the task segments in the ring — built by
    /// key, not from the clock (`naturalPage`), so a render shows the same
    /// page whatever time it is drawn. -10 is the Days segment; the default
    /// is Early morning with the segments' bars in its strip (2026-10-11).
    static func segmentEntry(
        key: Int = -10, groups gs: [ReminderGroupDTO]? = nil, segments segs: [TaskSegmentDTO]? = nil
    ) -> RemindersEntry {
        let gs = gs ?? groups
        let listed = TaskSegmentDTO.listed(segs ?? segments)
        let natural = RemindersTimeline.naturalSlotIndex(in: gs, now: now)
        let page = RemindersTimeline.page(forKey: key, groups: gs, segments: listed, naturalSlot: natural)
        return RemindersEntry(
            date: now, groups: gs, segments: listed, slotIndex: page.slotIndex,
            segmentIndex: page.segmentIndex, staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    /// Every period considered, and the Days segment finished too (its
    /// waiting rows considered) — Weeks still waits, so the day isn't done.
    static func segmentFinishedEntry() -> RemindersEntry {
        let gs = groups.map { g in
            ReminderGroupDTO(
                slot: g.slot, reminders: [], considered: g.considered + g.reminders.count,
                consideredItems: g.reminders + g.consideredItems, prompts: g.prompts.map { $0.handled(did: false) }
            )
        }
        let days = segments[0].replacingTasks(segments[0].tasks.map {
            SegmentTaskDTO(task: $0.task, state: $0.state == .waiting ? .considered : $0.state)
        })
        let listed = TaskSegmentDTO.listed([days] + segments.dropFirst())
        let page = RemindersTimeline.page(forKey: -10, groups: gs, segments: listed, naturalSlot: 0)
        return RemindersEntry(
            date: now, groups: gs, segments: listed, slotIndex: page.slotIndex,
            segmentIndex: page.segmentIndex, staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }
}

#Preview("Reminders Large — slot page with task bars", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.segmentEntry(key: ReminderPreviewData.earlyMorningKey)
}

#Preview("Reminders Large — task segment finished", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: -10)
    ReminderPreviewData.segmentFinishedEntry()
}

#Preview("Reminders Large — task segment (Days)", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: -10)
    ReminderPreviewData.segmentEntry()
}

#Preview("Reminders Large — task segment, considered shown", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: true, slotKey: -10)
    ReminderPreviewData.segmentEntry()
}

#Preview("Reminders Large — task segment (Upcoming)", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: -14, dayStart: "03:00")
    ReminderPreviewData.segmentEntry(key: -14)
}

#Preview("Reminders Large — task segment (Upcoming) page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 1, showCompleted: false, slotKey: -14, dayStart: "03:00")
    ReminderPreviewData.segmentEntry(key: -14)
}

#Preview("Reminders Large — task segment (Upcoming) page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 2, showCompleted: false, slotKey: -14, dayStart: "03:00")
    ReminderPreviewData.segmentEntry(key: -14)
}

#Preview("Reminders Large — task segment (Upcoming) page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 3, showCompleted: false, slotKey: -14, dayStart: "03:00")
    ReminderPreviewData.segmentEntry(key: -14)
}

#Preview("Reminders Medium — task segment (Upcoming)", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: -14, dayStart: "03:00")
    ReminderPreviewData.segmentEntry(key: -14)
}

/// Upcoming with an empty Tomorrow section (2026-10-26): its heading still
/// shows, "Tomorrow  0 of 0 ✓", with no row under it.
#Preview("Reminders Large — Upcoming, Tomorrow empty", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: -14, dayStart: "03:00")
    ReminderPreviewData.segmentEntry(
        key: -14,
        segments: ReminderPreviewData.segments.map {
            $0.isUpcoming ? $0.replacingTasks(ReminderPreviewData.upcomingLater) : $0
        }
    )
}

#Preview("Reminders Large — task segment (Weeks)", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: -11)
    ReminderPreviewData.segmentEntry(key: -11)
}

#Preview("Reminders Large — task segment (Quarterly)", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: -13)
    ReminderPreviewData.segmentEntry(key: -13)
}

#Preview("Reminders Medium — task segment (Quarterly)", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: -13)
    ReminderPreviewData.segmentEntry(key: -13)
}

#Preview("Reminders Medium — task segment (Days)", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.clearSlotOverride()
    ReminderPreviewData.segmentEntry()
}

#Preview("Reminders Large — page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 1, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 2, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 3, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 5", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 4, showCompleted: false)
    ReminderPreviewData.entry()
}

// Pages 6-10: with the sixteen sample quota prompts after the reminders
// (2026-09-24), Early morning runs to ten pages at XXX Large text.
#Preview("Reminders Large — page 6", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 5, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 7", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 6, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 8", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 7, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 9", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 8, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 10", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 9, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — prompts handled, completed on, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 99, showCompleted: true)
    ReminderPreviewData.promptsHandledEntry()
}

#Preview("Reminders Large — prompts only, page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.promptsOnlyEntry()
}

#Preview("Reminders Medium — prompts only", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.promptsOnlyEntry()
}

#Preview("Reminders Small — prompts only", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.promptsOnlyEntry()
}

#Preview("Reminders Large — Afternoon live, 4:30 PM", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.entry(slotIndex: 3, at: ReminderPreviewData.afternoon)
}

#Preview("Reminders Large — Evening finished early, 4:30 PM", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.eveningDoneEarlyEntry()
}

#Preview("Reminders Large — Evening page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: ReminderPreviewData.eveningKey)
    ReminderPreviewData.entry(slotIndex: ReminderPreviewData.eveningIndex)
}

#Preview("Reminders Large — Evening page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 1, showCompleted: false, slotKey: ReminderPreviewData.eveningKey)
    ReminderPreviewData.entry(slotIndex: ReminderPreviewData.eveningIndex)
}

#Preview("Reminders Large — Evening page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 2, showCompleted: false, slotKey: ReminderPreviewData.eveningKey)
    ReminderPreviewData.entry(slotIndex: ReminderPreviewData.eveningIndex)
}

#Preview("Reminders Large — completed on, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    // Past the end on purpose — the list clamps to its last page.
    let _ = ReminderPreviewData.prepare(page: 99, showCompleted: true)
    ReminderPreviewData.entry()
}

#Preview("Reminders Medium", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Medium — Evening", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: ReminderPreviewData.eveningKey)
    ReminderPreviewData.entry(slotIndex: ReminderPreviewData.eveningIndex)
}

/// The 2×2 once "Breakfast" is checked off: the paragraph-long reminder
/// becomes the one shown.
#Preview("Reminders Small — paragraph first", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.paragraphFirstEntry()
}

#Preview("Reminders Small", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.entry()
}

// MARK: - Day complete (2026-09-29, synthetic sample data)
//
// The finished states approved from mockups r3: "4 of 7" mid-period, a
// finished period's "Complete", and "Congratulations / Day complete" under
// the green wash on every period of a complete day. Six invented periods, 35 reminders plus
// one quota prompt (handled in Morning), so the done list pages.

private enum DayCompletePreviewData {
    static let slots: [(id: Int, label: String, start: String, titles: [String])] = [
        (21, "Early morning", "06:30", [
            "Drink a glass of water", "Stretch for five minutes", "Open the blinds", "Make the bed",
            "Take morning vitamins", "Water the plants", "Quick look at today's calendar",
        ]),
        (22, "Morning", "08:30", [
            "Check the team inbox", "Plan the top three things for today", "Refill water bottle",
            "Stand up and walk for a few minutes", "Clear the desk before starting deep work",
            "Reply to anything waiting since yesterday", "Posture check: shoulders down, feet flat",
            "Take a short break away from the screen", "Review notes from yesterday's meeting",
        ]),
        (23, "Lunchtime", "11:30", [
            "Eat lunch away from the desk", "Short walk outside", "Refill water bottle",
        ]),
        (24, "After work", "16:00", [
            "Unpack the bags", "Snack and a glass of water", "Check the calendar for tomorrow",
            "Start the laundry", "Ten minutes of tidying", "Sort the mail",
        ]),
        (25, "Pre-bedtime", "20:15", [
            "Brush teeth and floss", "Set out clothes for tomorrow",
        ]),
        (26, "Evening", "21:00", [
            "Pack lunches", "Tidy the kitchen counters", "Run the dishwasher",
            "Phone on the charger, out of the bedroom", "Lock the doors and check the stove",
            "Write down one good thing from today", "Read a few pages before sleep",
        ]),
    ]

    static func at(_ hour: Int, _ minute: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }

    /// Morning's one quota prompt — handled whenever Morning is.
    private static func morningPrompt(handled: Bool) -> QuotaPromptDTO {
        let waiting = QuotaPromptDTO(
            promptKey: "q:901:0:2026-09-29", taskId: 901, number: nil, title: "Read 20 pages", current: 2,
            target: 5, period: "WEEKLY", stripeColor: "blue", considered: false, done: false, hasNotes: false
        )
        return handled ? waiting.handled(did: true) : waiting
    }

    /// Periods at index <= `doneThrough` fully handled; `partial` more
    /// reminders handled in the period after that; the rest waiting.
    static func groups(doneThrough: Int, partial: Int = 0) -> [ReminderGroupDTO] {
        slots.enumerated().map { index, slot in
            let tasks = slot.titles.enumerated().map { i, title in
                TaskDTO(id: slot.id * 100 + i, title: title, priority: 0, isReminder: true)
            }
            let handled = index <= doneThrough ? tasks.count : (index == doneThrough + 1 ? partial : 0)
            let done = Array(tasks.prefix(handled))
            return ReminderGroupDTO(
                slot: TimeSlotDTO(id: slot.id, label: slot.label, startTime: slot.start),
                reminders: Array(tasks.dropFirst(handled)), considered: done.count,
                consideredItems: Array(done.reversed()),
                prompts: slot.id == 22 ? [morningPrompt(handled: index <= doneThrough)] : []
            )
        }
    }

    static func entry(at date: Date, groups: [ReminderGroupDTO], slotIndex: Int) -> RemindersEntry {
        RemindersEntry(
            date: date, groups: groups, segments: [], slotIndex: slotIndex, segmentIndex: nil, staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    /// 7:05 am: Early morning 4 of 7, nothing else touched.
    static var midPeriod: RemindersEntry {
        entry(at: at(7, 5), groups: groups(doneThrough: -1, partial: 4), slotIndex: 0)
    }

    /// 12:10 pm: Lunchtime finished, the afternoon and evening still to come.
    static var periodDone: RemindersEntry {
        entry(at: at(12, 10), groups: groups(doneThrough: 2), slotIndex: 2)
    }

    /// 9:08 pm, everything handled, on the clock's period (Evening).
    static var dayComplete: RemindersEntry {
        entry(at: at(21, 8), groups: groups(doneThrough: 5), slotIndex: 5)
    }

    /// The same day, paged back to Morning (its reminders + the prompt) —
    /// Congratulations here too, not only on the clock's period.
    static var dayCompleteOtherPeriod: RemindersEntry {
        entry(at: at(21, 8), groups: groups(doneThrough: 5), slotIndex: 1)
    }

    static func prepare(showCompleted: Bool) {
        WidgetStore.setShowCompleted(showCompleted, for: RemindersWidget.kind)
        for slot in slots { WidgetStore.setRemindersPage(0, for: slot.id) }
    }
}

#Preview("Reminders Large — mid-period, 4 of 7", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: false)
    DayCompletePreviewData.midPeriod
}

#Preview("Reminders Large — period done", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: false)
    DayCompletePreviewData.periodDone
}

#Preview("Reminders Large — day complete", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: false)
    DayCompletePreviewData.dayComplete
}

#Preview("Reminders Large — day complete, other period", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: false)
    DayCompletePreviewData.dayCompleteOtherPeriod
}

#Preview("Reminders Large — day complete, done list", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: true)
    DayCompletePreviewData.dayComplete
}

#Preview("Reminders Medium — day complete", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: false)
    DayCompletePreviewData.dayComplete
}

#Preview("Reminders Medium — period done", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: false)
    DayCompletePreviewData.periodDone
}

#Preview("Reminders Small — day complete", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: false)
    DayCompletePreviewData.dayComplete
}

#Preview("Reminders Small — period done", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = DayCompletePreviewData.prepare(showCompleted: false)
    DayCompletePreviewData.periodDone
}

#endif
