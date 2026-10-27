import SwiftUI
import WatchKit

/// Reminders page: the default period's reminders (`ReminderDefaultPage`,
/// via `WatchViewModel.displayedSlotIndex`; `GET /api/reminders`,
/// same payload the phone widgets render — read-only aside from checking
/// items off, no create/edit on the watch). Title + "N left", a slim
/// per-slot progress strip, ‹ › to page between slots, tap a row to consider
/// (check off) it, and a toolbar Undo. A finished period reads "Complete",
/// and every period "Congratulations · Day complete" once every period of
/// the day is clear (`ReminderDayProgress`, shared with the phone widget).
struct RemindersPageView: View {
    @ObservedObject var model: WatchViewModel
    /// The prompt whose touch-and-hold period list is open (2026-09-25).
    @State private var moveTarget: QuotaPromptDTO?

    private var group: ReminderGroupDTO? { model.displayedGroup }

    var body: some View {
        // `.navigationTitle`/`.toolbar` anchor to the single `NavigationStack`
        // `WatchRootView` wraps around the whole paged `TabView` — see that
        // file's doc for why a NavigationStack here too (one per page)
        // crashed on first run.
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                header
                if !model.reminderGroups.isEmpty {
                    SlotProgressStrip(
                        groups: model.reminderGroups, segments: model.listedSegments,
                        currentIndex: model.displayedSlotIndex
                    )
                }

                if let description = model.lastActionDescription {
                    Text(description)
                        .font(.caption2)
                        .foregroundStyle(WatchTheme.accent)
                }

                content

                // Task segments UNDER the time slot (Trent, 10-11: "Tasks
                // should go underneath Reminders"; 10-10 had them first).
                // Their own sections, never inside the slot's list or its
                // "N left". The deadlines page ALWAYS (native PR E): the one
                // queue page that nags reads "Nothing today ✓" in its teal
                // when nothing waits, like an empty Upcoming section.
                if model.hasLoadedOnce {
                    ForEach(model.listedSegments.filter(TaskSegmentSection.shows)) { segment in
                        TaskSegmentSection(segment: segment, model: model)
                    }
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Reminders")
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button {
                    step(-1)
                } label: {
                    Image(systemName: "chevron.left")
                }
                .disabled(model.reminderGroups.count < 2)

                Spacer()

                Button {
                    step(1)
                } label: {
                    Image(systemName: "chevron.right")
                }
                .disabled(model.reminderGroups.count < 2)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.undo()
                } label: {
                    Image(systemName: "arrow.uturn.backward.circle")
                }
                .disabled(!model.canUndo)
            }
        }
        .refreshable {
            await model.load()
        }
        // Touch and hold a quota prompt: move it to another period for good
        // (2026-09-25) — the Tasks page's touch-and-hold chooser, same shape.
        // A chooser, not a confirmation: each button IS the move, and the
        // toolbar Undo takes it back (Trent's "undo over confirm"). The
        // period it is in now is marked with a ✓.
        .confirmationDialog(
            moveTarget?.title ?? "Move",
            isPresented: Binding(
                get: { moveTarget != nil },
                set: { if !$0 { moveTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: moveTarget
        ) { prompt in
            let current = prompt.slotId ?? group?.slot?.id
            ForEach(model.promptPeriods) { slot in
                // Marked, not `.disabled`: a watchOS confirmationDialog
                // DROPS disabled buttons (seen in the 26.5 simulator), and
                // the list reads as "where is it now?" without the current
                // one. Tapping it just closes the list (`movePrompt` skips a
                // move to where the prompt already is).
                Button(slot.id == current ? "\(slot.label) ✓" : slot.label) {
                    model.movePrompt(prompt, from: current, to: slot)
                }
            }
        } message: { prompt in
            Text(Self.moveMessage(for: prompt))
        }
    }

    /// What the list moves. A daily row that stands for only some of the
    /// quota's numbers says which — the web bubble's label, same rule.
    static func moveMessage(for prompt: QuotaPromptDTO) -> String {
        guard let numbers = prompt.numbers, !numbers.isEmpty, numbers.count < prompt.target else {
            return "Move to"
        }
        let names = numbers.map(ordinal)
        let list = names.count == 1
            ? names[0]
            : names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
        return "Move the \(list) of \(prompt.target) to"
    }

    private static func ordinal(_ n: Int) -> String {
        let tens = n % 100
        if (11...13).contains(tens) { return "\(n)th" }
        switch n % 10 {
        case 1: return "\(n)st"
        case 2: return "\(n)nd"
        case 3: return "\(n)rd"
        default: return "\(n)th"
        }
    }

    /// The on-screen period has nothing waiting — the phone widget's words
    /// (2026-09-29, `ReminderDayProgress.emptyBody`): "Congratulations · Day
    /// complete" on every period once every period of the day (upcoming ones
    /// too) is clear, "Complete" for a finished period (no count line, as on
    /// the phone widget), and the plain empty state for a period that never
    /// had anything. It used to read "All caught up" for all three.
    @ViewBuilder
    private var periodFinishedView: some View {
        switch ReminderDayProgress.emptyBody(
            groups: model.reminderGroups, segments: model.listedSegments, displayedIndex: model.displayedSlotIndex
        ) {
        case .dayComplete:
            AllCaughtUpView(symbol: "checkmark.seal.fill", title: "Congratulations", detail: "Day complete")
        case .periodDone:
            AllCaughtUpView(symbol: "checkmark.seal.fill", title: "Complete")
        case .noReminders, .nothingHere, .nothingToday:
            AllCaughtUpView(title: "Nothing left here")
        }
    }

    @ViewBuilder
    private var header: some View {
        if let group {
            VStack(alignment: .leading, spacing: 2) {
                Text(group.label)
                    .font(.headline)
                // Reminders plus waiting quota prompts (2026-09-24).
                Text(group.hasNothingWaiting ? "Done" : "\(group.waitingCount) left")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if model.isLoading {
            Text("Reminders")
                .font(.headline)
        }
    }

    @ViewBuilder
    private var content: some View {
        // Gate the empty/loaded states on `hasLoadedOnce` — before the first
        // fetch completes, `group` is nil (no data yet) exactly like the
        // genuinely-empty case below, and without this a launch would flash
        // an empty state for the ~1-3s a real network round trip takes
        // before honestly landing on real content. See `WatchViewModel.
        // hasLoadedOnce`'s doc.
        if !model.hasLoadedOnce {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
        } else if let error = model.loadError, model.reminderGroups.isEmpty {
            LoadErrorView(message: error)
        } else if let group {
            if group.hasNothingWaiting {
                periodFinishedView
            } else {
                // No `lineLimit` here — Trent's rule (memory:
                // "never truncate a reminder"): a reminder is a short
                // prompted thought, and the watch's column is narrow enough
                // that clipping one defeats the point of showing it at all.
                ForEach(group.reminders) { task in
                    Button {
                        model.completeReminder(task)
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "circle")
                                .foregroundStyle(WatchTheme.accent)
                                .font(.caption)
                                .padding(.top, 3)
                            WatchTheme.titleText(Text(task.title), hasNotes: task.hasNotes)
                                .font(.body.weight(WatchTheme.priorityWeight(task.priority)))
                                .multilineTextAlignment(.leading)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(NotesGlyph.accessibilityLabel(task.title, hasNotes: task.hasNotes)))
                }
                // Quota prompts after the reminders, as on the web
                // (`SlotPromptList`) and the phone widget. Keyed by
                // `prompt_key` — a daily quota's rows share one task id.
                ForEach(group.waitingPrompts) { prompt in
                    PromptRowView(
                        prompt: prompt,
                        consider: { model.actOnPrompt(prompt, did: false) },
                        didIt: { model.actOnPrompt(prompt, did: true) },
                        hold: !model.canMove(prompt) ? nil : {
                            WKInterfaceDevice.current().play(.click)
                            moveTarget = prompt
                        }
                    )
                }
            }
        } else {
            // Loaded, no error, and still no group at all — a real state
            // (an account with no time slots and no un-slotted reminders
            // either), not a loading flicker: `hasLoadedOnce` above already
            // owns the "still fetching" case.
            Text("No reminders configured yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func step(_ offset: Int) {
        guard !model.reminderGroups.isEmpty else { return }
        let count = model.reminderGroups.count
        let current = model.displayedSlotIndex
        model.slotOverride = ((current + offset) % count + count) % count
    }
}

/// One segment per slot with something in it — the reminders' purple while
/// waiting (`WatchTheme.dayBarFilling`, indigo until 2026-10-26), green once
/// finished, a faint placeholder before it starts. The on-screen
/// segment draws twice as thick so it's identifiable without reading text —
/// the phone widget's `ReminderSlotStrip` treatment. It also wore an outline
/// until 2026-10-11 (Trent: no outline on any bar; it should just grow).
///
/// Then one bar per task segment shown today (2026-10-11, "segments as
/// slots", the phone widget's strip): purple while a row waits, green once
/// none does — a period's colours (2026-10-26; each filled in its horizon's
/// teal before) — never the faint "not started" look: a segment is shown
/// today.
/// Never ringed: the page doesn't page to a segment, it lists every waiting
/// segment's rows under whichever period is on screen, so the bar's job is
/// "there is more below, and this much of it is done".
private struct SlotProgressStrip: View {
    let groups: [ReminderGroupDTO]
    /// `WatchViewModel.listedSegments` — today's segments, considers drawn.
    let segments: [TaskSegmentDTO]
    let currentIndex: Int

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(groups.enumerated()), id: \.element.slotKey) { index, group in
                // The on-screen period grows, with no outline — the phone
                // widget's treatment (Trent, 2026-10-11: no outline on any
                // bar).
                Capsule()
                    .fill(color(for: group))
                    .frame(height: index == currentIndex ? 6 : 3)
            }
            // The faint divider between periods and tasks (2026-10-11,
            // option 3), only when both are there.
            if !groups.isEmpty, !segments.isEmpty {
                Rectangle()
                    .fill(WatchTheme.stripSeparator)
                    .frame(width: 1, height: 8)
                    .padding(.horizontal, 2)
                    .accessibilityHidden(true)
            }
            // Purple while a row waits, green once none does — a period's
            // colours. Whole-bar fills, like the watch's slot bars (which
            // have no partial fill either).
            ForEach(segments) { segment in
                Capsule()
                    .fill(segment.hasWaiting ? WatchTheme.dayBarFilling : WatchTheme.dayBarDone(segment.kind))
                    .frame(height: 3)
                    .accessibilityLabel(Text(segment.title))
            }
        }
        .frame(height: 8)
    }

    private func color(for group: ReminderGroupDTO) -> Color {
        switch WatchSlotLogic.state(for: group) {
        case .notStarted: return Color.secondary.opacity(0.25)
        case .waiting: return WatchTheme.dayBarFilling
        case .finished: return WatchTheme.done
        }
    }
}

/// One waiting quota PROMPT (quota reminders, 2026-09-24) — drawn as a
/// reminder row (the full-width wrapped title, tap to consider), plus the
/// four things a prompt adds everywhere: a thin leading stripe in the
/// quota's label color, the count ("1/2"), a SQUARE for "did it", and a
/// DASHED circle where a reminder has its solid one (2026-09-25 — the verb is
/// still "considered", but Trent read the solid circle as "done"; an eye came
/// first and read as creepy, so the dashed circle is his pick).
///
/// WHY A SQUARE BUTTON, NOT PRESS-AND-HOLD (the judgment call): "did it" is
/// the prompt's success action — the one Trent is meant to reach for when he
/// has done the thing — and a hold is invisible; the Tasks page keeps hold
/// for its RARE action (snooze). A mis-tap logs +1, which the toolbar Undo
/// takes back.
///
/// HOLD = MOVE TO ANOTHER PERIOD (2026-09-25), the prompt's rare action, as
/// snooze is a task's: touch and hold the title opens the page's period
/// list. The title area is therefore a tap + long-press gesture pair (the
/// Tasks page's `TaskRow` pattern), not a `Button` — a Button fires its
/// action on the release that ends a hold, so the hold would ALSO consider
/// the prompt. The square stays a real `Button`, a sibling, never nested.
///
/// WHY THE COUNT AND SQUARE SIT ON THEIR OWN LINE: the first build put the
/// square in a column beside the title, and on the 44mm SE simulator that
/// left realistic titles one or two words per line ("commu-nity"
/// hyphenated) with the count wrapping away from its "·". Under the title,
/// right-aligned, the title keeps a reminder's full width, and the square is
/// literally "next to the count": `1/3 ☐`. It costs one short line per
/// prompt; the page scrolls. The square is its own button (a 40×28 target),
/// a sibling of the row's consider button, never nested in it.
struct PromptRowView: View {
    let prompt: QuotaPromptDTO
    let consider: () -> Void
    let didIt: () -> Void
    /// Touch and hold: the period list. `nil` = no periods to offer.
    var hold: (() -> Void)?
    /// The count's em: `.body`, scaled with the wearer's text size from
    /// watchOS's default 17pt (`@ScaledMetric` follows the view's own
    /// Dynamic Type, which a process-wide `UIFont` lookup doesn't).
    @ScaledMetric(relativeTo: .body) private var countEm: CGFloat = 17

    /// "Piano Scales, 1 of 2 today" (+ ", has notes") — both buttons' label.
    private var spokenLabel: String {
        NotesGlyph.accessibilityLabel("\(prompt.title), \(prompt.spokenCount)", hasNotes: prompt.hasNotes)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            RoundedRectangle(cornerRadius: 2)
                .fill(WatchTheme.labelColor(prompt.stripeColor))
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "circle.dashed")
                        .foregroundStyle(WatchTheme.accent)
                        .font(.caption)
                        .padding(.top, 3)
                        // The row is the control ("Considered: …"); the
                        // symbol's own "Show" label would only add noise.
                        .accessibilityHidden(true)
                    // The notes glyph goes after the TITLE here, not after
                    // the count as on the phone and web: this row's count
                    // sits on its own line below, beside the did-it square.
                    WatchTheme.titleText(Text(prompt.title), hasNotes: prompt.hasNotes)
                        .font(.body)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
                .onTapGesture(perform: consider)
                // 0.4s, the Tasks page's: a tap still considers, a scroll
                // never triggers it.
                .onLongPressGesture(minimumDuration: 0.4) { hold?() }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(Text("Considered: \(spokenLabel)"))
                .accessibilityAction(named: Text("Move to another period")) { hold?() }

                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    // The phone's segments (2026-10-13): this count has a
                    // line of its own, right-aligned beside ☐, so even six
                    // boxes and "month" fit at XXX Large on the 44mm SE;
                    // `QuotaSegments`' `ViewThatFits` falls back to "3/7
                    // today" if they ever don't, and above six.
                    QuotaSegments(
                        current: prompt.current, target: prompt.target, period: prompt.period,
                        em: countEm,
                        palette: .init(fill: WatchTheme.accent, met: WatchTheme.done, metText: WatchTheme.done),
                        // An interval quota's end, "by Oct 24" (2026-10-16).
                        periodLabel: prompt.periodLabel
                    )
                    Button(action: didIt) {
                        Image(systemName: "square")
                            .font(.body)
                            .foregroundStyle(WatchTheme.accent)
                            .frame(width: PromptRowView.didTarget.width, height: PromptRowView.didTarget.height)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Did it: \(spokenLabel)"))
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// The did-it square's tap target — a finger target on the narrowest watch.
    static let didTarget = CGSize(width: 40, height: 28)
}

/// One task segment on the Reminders page (2026-10-10, docs/TASK-MODEL.md
/// § Task segments): headed like a time slot ("Task queue · Daily" / "3 left"),
/// its waiting rows in the server's fixed order, and Defer all. Shown only
/// while something waits — a considered row leaves the list at once (the
/// toolbar Undo brings it back).
///
/// Built for rapid-fire considering (Trent, 2026-10-11: twenty in a row
/// should take as long as twenty reminders): each row is a plain `Button`
/// like a reminder row, the checkbox sits inline on the right, and the
/// model applies a consider locally before the request goes out. No
/// "try Process" here — that nudge belongs on the phone and the web.
struct TaskSegmentSection: View {
    let segment: TaskSegmentDTO
    @ObservedObject var model: WatchViewModel

    /// Which segments the page shows: every one with a row waiting, and the
    /// deadlines page always (native PR E) — finished or empty it reads
    /// "Nothing today ✓", finishing in its teal.
    static func shows(_ segment: TaskSegmentDTO) -> Bool {
        segment.hasWaiting || segment.kind == .deadlines
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(segment.wrappingTitle)
                    .font(.headline)
                    .foregroundStyle(WatchTheme.taskSegment(segment.kind))
                if segment.hasWaiting {
                    Text("\(segment.waitingCount) left")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.top, 6)
            if !segment.hasWaiting {
                // Only the deadlines page gets here (`shows`): done, in its
                // own teal (`WatchTheme.dayBarDone`).
                NothingTodayLine(tint: WatchTheme.dayBarDone(segment.kind))
            } else if segment.isUpcoming {
                // Upcoming in two sections (2026-10-26, ruling 1), drawn like
                // the web: each section's heading and its own "n of m", its
                // rows, and "Nothing today ✓" when it holds none.
                ForEach(UpcomingSections.split(segment.tasks), id: \.section) { section in
                    UpcomingSectionHeader(section: section)
                    if section.isEmpty {
                        NothingTodayLine()
                    }
                    rows(section.waiting)
                }
            } else {
                rows(segment.waitingTasks)
            }
            // An ordinary watch action button (the bulk-snooze sheet's
            // weight), not a small tinted link. Never on the queue's panels
            // or the deadlines page (native PR E, `offersDeferAll`): the
            // deadlines page's Defer is one row's lead day, in the app.
            if segment.hasWaiting, segment.offersDeferAll {
                Button {
                    model.deferSegment(segment)
                } label: {
                    Label("Defer all", systemImage: "arrow.turn.down.right")
                        .font(.footnote.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .accessibilityLabel(Text("Defer all \(segment.label) tasks to tomorrow"))
            }
        }
    }

    private func rows(_ rows: [SegmentTaskDTO]) -> some View {
        ForEach(rows) { row in
            SegmentRowView(
                task: row.task, segmentHorizon: segment.horizon, upcomingSection: row.upcomingSection,
                seenInSafetyNet: row.isSeenInSafetyNet,
                consider: { model.considerSegmentTask(row.task) },
                done: { model.completeSegmentTask(row.task) }
            )
        }
    }
}

/// An Upcoming section's heading on the watch (2026-10-26, the web's
/// `SectionHeading`): the word, muted, and the section's own "n of m" — green
/// with a ✓ once nothing in it waits.
private struct UpcomingSectionHeader: View {
    let section: UpcomingSections.Section

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(section.section.title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            (section.finished
                ? Text(section.countText) + Text("\u{00A0}") + Text(Image(systemName: "checkmark"))
                : Text(section.countText))
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(section.finished ? WatchTheme.done : Color.secondary)
        }
        .padding(.top, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(section.section.title), \(section.handledCount) of \(section.total) considered"))
    }
}

/// "Nothing today ✓" — an empty Upcoming section (Trent's words, the web's
/// `EmptySegmentLine`): muted text, a green check — the deadlines page's own
/// teal there (native PR E, `tint`).
private struct NothingTodayLine: View {
    var tint: Color = WatchTheme.done

    var body: some View {
        (Text("Nothing today ") + Text(Image(systemName: "checkmark")).foregroundStyle(tint))
            .font(.footnote)
            .foregroundStyle(.secondary)
    }
}

/// One task segment row, a reminder row's shape: circle, title (and under it
/// the small words — horizon when it differs from the segment's, a future
/// target "Nov 1", the deadline), and the done checkbox INLINE on the right,
/// like a quota prompt's. A tap on the circle or title considers ("I saw
/// it", never a completion — the web row's rule); the checkbox completes.
/// Horizon change and remove-target are not on the watch: they live in the
/// app (amendment 16 allows a deep link; the watch has no web view).
struct SegmentRowView: View {
    let task: TaskDTO
    let segmentHorizon: String
    /// An Upcoming row's section: a Tomorrow row's target is its time alone.
    var upcomingSection: UpcomingSection? = nil
    /// A deadlines-page safety-net row seen today (native PR E): it stays,
    /// waiting, its circle filled and the tap inert.
    var seenInSafetyNet = false
    let consider: () -> Void
    let done: () -> Void

    private var meta: String? { task.segmentMeta(segmentHorizon: segmentHorizon, upcomingSection: upcomingSection) }

    private var spoken: String {
        let words = meta.map { ", \($0.replacingOccurrences(of: "\u{00A0}", with: " "))" } ?? ""
        return NotesGlyph.accessibilityLabel("\(task.title)\(words)", hasNotes: task.hasNotes)
    }

    /// The small words, the attempts badge ("3×", always last) in plum like
    /// the phone widget's row; the age label stays secondary.
    private func metaText(_ words: String) -> Text {
        if let badge = TargetAge.attemptsBadge(task), words.hasSuffix(badge) {
            return Text(String(words.dropLast(badge.count))).font(.caption2).foregroundStyle(.secondary)
                + Text(badge).font(.caption2.weight(.semibold)).foregroundStyle(WatchTheme.overdue)
        }
        return Text(words).font(.caption2).foregroundStyle(.secondary)
    }

    /// An Upcoming row's words on ONE line (2026-10-12, Trent's review of
    /// #251): the first `UpcomingMetaForm` whose words fit the row's width
    /// on one line — `ViewThatFits` compares each one-line candidate's
    /// ideal width — and the shortest, wrapping, when none does (the
    /// accessibility sizes).
    private var upcomingWords: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(UpcomingMetaForm.allCases, id: \.self) { form in
                if let words = task.segmentMeta(
                    segmentHorizon: segmentHorizon, upcomingForm: form, upcomingSection: upcomingSection
                ) {
                    metaText(words).lineLimit(1).fixedSize()
                }
            }
            if let words = task.segmentMeta(
                segmentHorizon: segmentHorizon, upcomingForm: .shortest, upcomingSection: upcomingSection
            ) {
                metaText(words)
            }
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            Button(action: consider) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: seenInSafetyNet ? "circle.inset.filled" : "circle")
                        .foregroundStyle(WatchTheme.accent)
                        .font(.caption)
                        .padding(.top, 3)
                    VStack(alignment: .leading, spacing: 1) {
                        WatchTheme.titleText(Text(task.title), hasNotes: task.hasNotes)
                            .font(.body.weight(WatchTheme.priorityWeight(task.priority)))
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        if segmentHorizon == SegmentKind.upcomingRaw {
                            upcomingWords
                        } else if let meta {
                            metaText(meta)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(seenInSafetyNet)
            .accessibilityLabel(Text(
                seenInSafetyNet ? "Seen today, the deadline is close, so it stays: \(spoken)" : "Considered: \(spoken)"
            ))

            Button(action: done) {
                Image(systemName: "square")
                    .font(.body)
                    .foregroundStyle(WatchTheme.accent)
                    .frame(width: PromptRowView.didTarget.width, height: PromptRowView.didTarget.height)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Done: \(spoken)"))
        }
    }
}

/// Shared empty state — the Tasks page's "All caught up" (nothing up next),
/// and the Reminders page's finished-period states (`periodFinishedView`:
/// "Complete" / "Day complete", 2026-09-29), which pass their own words.
struct AllCaughtUpView: View {
    var symbol = "checkmark.circle.fill"
    var title = "All caught up"
    var detail: String?

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(WatchTheme.done)
            VStack(spacing: 2) {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(detail == nil ? .secondary : .primary)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

/// Shared by both pages (Reminders and Tasks) — shown only when a fetch
/// failed AND there's no cached payload to fall back on (`WatchViewModel.
/// load()`'s doc: a stale-but-present cache is preferred over this).
struct LoadErrorView: View {
    let message: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "wifi.exclamationmark")
                .font(.title2)
                .foregroundStyle(.orange)
            Text("Couldn't load")
                .font(.subheadline)
            Text(message)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

#if DEBUG
// Quota prompts (2026-09-24) on realistic sample data: two reminders, then the
// sixteen prompts — stripe, count, the dashed circle (tap = considered) and the
// square (did it). The second preview has three handled, so they're gone.
#Preview("Reminders — task segment first") {
    NavigationStack {
        RemindersPageView(model: .previewReminders(segments: true))
    }
}

#Preview("Reminders — prompts") {
    NavigationStack {
        RemindersPageView(model: .previewReminders())
    }
}

#Preview("Reminders — prompts, three handled") {
    NavigationStack {
        RemindersPageView(model: .previewReminders(handled: [
            "q:83:1:2026-09-24": true, "q:116:0:2026-09-24": false, "q:3307:0:2026-09-24": false,
        ]))
    }
}

#Preview("Reminders — prompts, XXX Large") {
    NavigationStack {
        RemindersPageView(model: .previewReminders())
    }
    .dynamicTypeSize(.xxxLarge)
}

// A preview can't scroll, so the page previews above only show the first
// rows. These draw every one of the sixteen sample prompt rows, five or six
// at a time, as the page lists them (clamped, for local data with fewer).
private struct PromptRowsPreview: View {
    let range: Range<Int>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let prompts = WatchPreviewData.earlyMorningPrompts
            ForEach(prompts[range.clamped(to: prompts.indices)]) { prompt in
                PromptRowView(prompt: prompt, consider: {}, didIt: {})
            }
        }
        .padding(.horizontal, 4)
        // The 44mm SE's 184pt screen, the narrowest watch he wears — the
        // preview canvas renders on whichever simulator Xcode picks.
        .frame(width: 184)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

// The task segments' sections on their own (2026-10-26, "Task queue ·
// Daily" titles), for the same reason: on the page they sit below every
// period row, out of a preview's reach.
private struct SegmentSectionPreview: View {
    let segment: TaskSegmentDTO
    let model = WatchViewModel.previewReminders(segments: true)

    init(horizon: String) {
        segment = WatchPreviewData.taskSegments.first { $0.horizon == horizon }
            ?? TaskSegmentDTO(horizon: horizon, tasks: [])
    }

    init(segment: TaskSegmentDTO) {
        self.segment = segment
    }

    var body: some View {
        ScrollView {
            TaskSegmentSection(segment: segment, model: model)
                .padding(.horizontal, 4)
                .frame(width: 184)
        }
    }
}

#Preview("Task segment section — Upcoming") { SegmentSectionPreview(horizon: "upcoming") }
#Preview("Task segment section — Upcoming, Tomorrow empty") {
    SegmentSectionPreview(segment: WatchPreviewData.upcomingTomorrowEmpty)
}

#Preview("Prompt rows 1-5") { PromptRowsPreview(range: 0..<5) }
#Preview("Prompt rows 6-10") { PromptRowsPreview(range: 5..<10) }
#Preview("Prompt rows 11-16") { PromptRowsPreview(range: 10..<16) }
#Preview("Prompt rows 1-4, XXX Large") {
    PromptRowsPreview(range: 0..<4).dynamicTypeSize(.xxxLarge)
}
#Preview("Prompt rows 3-5, XXX Large") {
    // The longest count: "0/1 this month" (Vacuum the car mats) and "0/2 today".
    PromptRowsPreview(range: 2..<5).dynamicTypeSize(.xxxLarge)
}
#endif
