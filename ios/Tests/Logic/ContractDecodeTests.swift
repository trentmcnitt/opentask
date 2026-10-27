import XCTest

/// The server's real responses (`tests/fixtures/contract/`), decoded by the
/// same DTOs every native surface uses — asserting VALUES, not just that
/// decoding didn't throw. `QuotaPromptDTO`/`ReminderGroupDTO`/`TaskDTO`
/// default nearly every field, so a renamed server field (`done` →
/// `is_done`) would decode silently as `false`; only a value check catches
/// that. See `Fixtures` for the scenario's placeholders.
final class ContractDecodeTests: WidgetStoreTestCase {

    // MARK: GET /api/reminders

    func testRemindersGroupsAndCounts() throws {
        let groups = try Fixtures.reminders()
        XCTAssertEqual(groups.map(\.slot?.id), [11, 12, 13, 14, 15, nil])
        XCTAssertEqual(groups.map(\.label), ["Early morning", "Morning", "Midday", "Afternoon", "Evening", "Anytime"])
        XCTAssertEqual(groups.map(\.slotKey), [11, 12, 13, 14, 15, -1])

        // Early morning: Stretch considered; Call a friend waiting; Drink
        // water #1 and Go for a run handled.
        let early = groups[0]
        XCTAssertEqual(early.reminders.map(\.id), [])
        XCTAssertEqual(early.considered, 1)
        XCTAssertEqual(early.consideredItems.map(\.id), [Fixtures.stretch])
        XCTAssertEqual(early.waitingPrompts.map(\.taskId), [Fixtures.monthly])
        XCTAssertEqual(early.handledPrompts.map(\.taskId), [Fixtures.daily, Fixtures.weekly])
        XCTAssertEqual(early.waitingCount, 1)
        XCTAssertEqual(early.consideredCount, 3)
        XCTAssertFalse(early.hasNothingWaiting)

        // Morning: Drink water #2 alone, waiting.
        XCTAssertEqual(groups[1].prompts.map(\.promptKey), [Fixtures.promptKey(Fixtures.daily, 2)])
        XCTAssertEqual(groups[1].waitingCount, 1)
        XCTAssertEqual(groups[1].consideredCount, 0)

        // Afternoon: Plan tomorrow (19:00) waiting.
        XCTAssertEqual(groups[3].reminders.map(\.id), [Fixtures.planTomorrow])
        XCTAssertEqual(groups[3].reminders.first?.anchorTime, "19:00")
        XCTAssertEqual(groups[3].reminders.first?.isReminder, true)

        // The rest are empty.
        for i in [2, 4, 5] { XCTAssertTrue(groups[i].hasNothingWaiting, "group \(i)") }
        XCTAssertEqual(groups.map(\.waitingCount).reduce(0, +), 3)
        XCTAssertEqual(groups.map(\.consideredCount).reduce(0, +), 3)
    }

    func testPromptValues() throws {
        let one = try Fixtures.prompt(Fixtures.promptKey(Fixtures.daily, 1))
        XCTAssertEqual(one.taskId, Fixtures.daily)
        XCTAssertEqual(one.number, 1)
        XCTAssertEqual(one.numbers, [1])
        XCTAssertEqual(one.slotId, 11)
        XCTAssertEqual(one.title, "Drink water")
        XCTAssertEqual(one.current, 1)
        XCTAssertEqual(one.target, 2)
        XCTAssertEqual(one.period, "DAILY")
        XCTAssertEqual(one.stripeColor, "purple")
        XCTAssertTrue(one.hasNotes)
        XCTAssertTrue(one.considered)
        XCTAssertTrue(one.done)
        XCTAssertEqual(one.countText, "1/2\u{00A0}today")
        XCTAssertEqual(one.labelText, "Drink water ·\u{00A0}1/2\u{00A0}today")

        let two = try Fixtures.prompt(Fixtures.promptKey(Fixtures.daily, 2))
        XCTAssertEqual(two.numbers, [2])
        XCTAssertEqual(two.slotId, 12)
        XCTAssertFalse(two.considered)
        XCTAssertFalse(two.done)
        XCTAssertTrue(two.isWaiting)

        let weekly = try Fixtures.prompt(Fixtures.promptKey(Fixtures.weekly, 0))
        XCTAssertNil(weekly.number)
        XCTAssertNil(weekly.numbers)
        XCTAssertNil(weekly.stripeColor)
        XCTAssertFalse(weekly.hasNotes)
        XCTAssertTrue(weekly.done)
        XCTAssertTrue(weekly.considered)
        XCTAssertEqual(weekly.countText, "1/3\u{00A0}week")

        let monthly = try Fixtures.prompt(Fixtures.promptKey(Fixtures.monthly, 0))
        XCTAssertTrue(monthly.isWaiting)
        XCTAssertEqual(monthly.countText, "0/2\u{00A0}month")
        XCTAssertEqual(monthly.slotId, 11)
    }

    /// The decoded DTO against the raw JSON, field by field, for EVERY prompt
    /// in every reminders capture: a renamed key would decode to its default
    /// and disagree here even where the scenario's pinned values happen to
    /// match the default.
    func testEveryPromptFieldComesFromTheWire() throws {
        for name in ["reminders-initial", "reminders-after-did", "reminders"] {
            let raw = try Fixtures.object(name)
            let rawPrompts = try XCTUnwrap(raw["groups"] as? [[String: Any]]).flatMap {
                $0["prompts"] as? [[String: Any]] ?? []
            }
            let decoded = try Fixtures.prompts(name)
            XCTAssertEqual(decoded.count, 4, name)
            XCTAssertEqual(rawPrompts.count, decoded.count, name)
            for (r, p) in zip(rawPrompts, decoded) {
                let expected: Set<String> = [
                    "prompt_key", "task_id", "number", "numbers", "slot_id", "title", "current", "target",
                    "period", "stripe_color", "considered", "done", "has_notes",
                    "period_interval", "period_end", "period_last_day", "period_label", "priority",
                ]
                XCTAssertEqual(Set(r.keys), expected, "\(name): the wire keys QuotaPromptDTO decodes")
                XCTAssertEqual(r["prompt_key"] as? String, p.promptKey)
                XCTAssertEqual(r["task_id"] as? Int, p.taskId)
                XCTAssertEqual(r["number"] as? Int, p.number)
                XCTAssertEqual(r["numbers"] as? [Int], p.numbers)
                XCTAssertEqual(r["slot_id"] as? Int, p.slotId)
                XCTAssertEqual(r["title"] as? String, p.title)
                XCTAssertEqual(r["current"] as? Int, p.current)
                XCTAssertEqual(r["target"] as? Int, p.target)
                XCTAssertEqual(r["period"] as? String, p.period)
                XCTAssertEqual(r["stripe_color"] as? String, p.stripeColor)
                XCTAssertEqual(r["considered"] as? Bool, p.considered)
                XCTAssertEqual(r["done"] as? Bool, p.done)
                XCTAssertEqual(r["has_notes"] as? Bool, p.hasNotes)
                XCTAssertEqual(r["period_interval"] as? Int, p.periodInterval)
                XCTAssertEqual(r["period_end"] as? String, p.periodEnd)
                XCTAssertEqual(r["period_last_day"] as? String, p.periodLastDay)
                XCTAssertEqual(r["period_label"] as? String, p.periodLabel)
                XCTAssertEqual(r["priority"] as? Int, p.priority)
                // Interval 1 everywhere in these captures: no label, the FREQ's word.
                XCTAssertEqual(p.periodInterval, 1)
                XCTAssertNil(p.periodLabel)
            }
        }
    }

    // MARK: POST /api/quota-prompts/did

    func testDidResponseDecodes() throws {
        let result = try Fixtures.decode(APIClient.PromptActionResult.self, "quota-prompts-did")
        XCTAssertTrue(result.decoded)
        XCTAssertEqual(result.considered, 0)
        XCTAssertEqual(result.did, 1)
        XCTAssertEqual(result.tasks.count, 1)
        let task = try XCTUnwrap(result.tasks.first)
        XCTAssertEqual(task.id, Fixtures.daily)
        XCTAssertEqual(task.progressCurrent, 1)
        XCTAssertEqual(task.progressTarget, 2)
        XCTAssertTrue(task.isTracked)
        XCTAssertTrue(task.hasNotes)
        XCTAssertEqual(task.labels, ["personal"])
        XCTAssertEqual(task.rrule, "FREQ=DAILY")
        XCTAssertNotNil(task.periodStartDate, "the pinned ISO parses")
    }

    /// `handled(did:)` — the optimistic render — draws exactly what the
    /// server then returns for the acted row.
    func testHandledDidMatchesTheServersPostDidPrompt() throws {
        let key = Fixtures.promptKey(Fixtures.daily, 1)
        let before = try Fixtures.prompt(key, in: "reminders-initial")
        XCTAssertTrue(before.isWaiting)
        XCTAssertEqual(before.handled(did: true), try Fixtures.prompt(key, in: "reminders-after-did"))
    }

    /// `confirmPromptAction` with the did response's `tasks`, applied to the
    /// pre-action cache, yields the server's own post-action payload — every
    /// group, every prompt, sibling rows included.
    func testConfirmPromptActionReproducesThePostDidPayload() throws {
        WidgetStore.saveReminders(try Fixtures.reminders("reminders-initial"), taskSegments: [])
        let result = try Fixtures.decode(APIClient.PromptActionResult.self, "quota-prompts-did")
        WidgetStore.confirmPromptAction(Fixtures.promptKey(Fixtures.daily, 1), did: true, tasks: result.tasks)

        let cached = try XCTUnwrap(WidgetStore.loadReminders()).value.groups
        let server = try Fixtures.reminders("reminders-after-did")
        XCTAssertEqual(cached, server)
        XCTAssertEqual(cached.map(\.waitingCount), server.map(\.waitingCount))
        XCTAssertEqual(cached.map(\.consideredCount), server.map(\.consideredCount))
    }

    // MARK: POST /api/quota-prompts/consider (Push PR 4b, QUOTA_NAG's Considered)

    /// The consider answer: one considered, nothing logged, and the quota as
    /// the server left it. The raw keys too, since the DTO defaults every
    /// field: a renamed key would otherwise decode as 0 / [].
    func testConsiderResponseDecodes() throws {
        let result = try Fixtures.decode(APIClient.PromptActionResult.self, "quota-prompts-consider")
        XCTAssertTrue(result.decoded)
        XCTAssertEqual(result.considered, 1)
        XCTAssertEqual(result.did, 0)
        let task = try XCTUnwrap(result.tasks.first)
        XCTAssertEqual(result.tasks.count, 1)
        XCTAssertEqual(task.id, Fixtures.namedQuota)
        XCTAssertEqual(task.priority, 2)
        XCTAssertTrue(task.isTracked)
        XCTAssertEqual(task.progressTarget, 3)
        XCTAssertEqual(task.progressCurrent, 0, "a consider logs nothing")
        let raw = try Fixtures.object("quota-prompts-consider")
        // `undo_id` (2026-10-26): the entry this consider wrote, for scoped Undo.
        XCTAssertEqual(Set(raw.keys), ["considered", "did", "tasks", "undo_id"])
    }

    // MARK: POST /api/quota-prompts/restore (2026-09-25)

    func testRestoreResponseDecodes() throws {
        let result = try Fixtures.decode(APIClient.PromptRestoreResult.self, "quota-prompts-restore")
        XCTAssertTrue(result.decoded)
        XCTAssertEqual(result.restored, 1)
        let task = try XCTUnwrap(result.tasks.first)
        XCTAssertEqual(task.id, Fixtures.daily)
        XCTAssertEqual(task.progressCurrent, 0, "the did-it's +1 came off")
        XCTAssertEqual(task.progressTarget, 2)
        XCTAssertTrue(task.isTracked)
        // The raw day record: the key left both lists.
        let raw = try XCTUnwrap((try Fixtures.object("quota-prompts-restore")["tasks"] as? [[String: Any]])?.first)
        let day = try XCTUnwrap(raw["quota_day_state"] as? [String: Any])
        XCTAssertEqual(day["did"] as? [String], [])
        XCTAssertEqual(day["considered"] as? [String], [])
        XCTAssertEqual(day["logged"] as? Int, 0)
    }

    /// `confirmPromptRestore` with the restore response's `tasks`, applied to
    /// the post-did cache, yields the server's own pre-did payload: the
    /// put-back is the did-it undone, every group and prompt included.
    func testConfirmPromptRestoreReproducesThePreDidPayload() throws {
        WidgetStore.saveReminders(try Fixtures.reminders("reminders-after-did"), taskSegments: [])
        let result = try Fixtures.decode(APIClient.PromptRestoreResult.self, "quota-prompts-restore")
        WidgetStore.confirmPromptRestore(Fixtures.promptKey(Fixtures.daily, 1), tasks: result.tasks)

        let cached = try XCTUnwrap(WidgetStore.loadReminders()).value.groups
        XCTAssertEqual(cached, try Fixtures.reminders("reminders-initial"))
    }

    // MARK: POST /api/tasks/{id}/progress

    func testProgressResponseDecodesAsATask() throws {
        // `APIClient.logProgress` decodes the envelope as a bare TaskDTO.
        let task = try Fixtures.decode(TaskDTO.self, "task-progress")
        XCTAssertEqual(task.id, Fixtures.weekly)
        XCTAssertEqual(task.title, "Go for a run")
        XCTAssertEqual(task.progressCurrent, 1)
        XCTAssertEqual(task.progressTarget, 3)
        XCTAssertTrue(task.isTracked)
        XCTAssertFalse(task.isProgressMet)
        XCTAssertEqual(QuotaPeriodKey.from(rrule: task.rrule), .weekly)
    }

    // MARK: POST /api/tasks/bulk/complete

    /// `APIClient.completeTasks(ids:prompts:)` reads these three keys through
    /// JSONSerialization and defaults each to 0 — so a rename would read as
    /// "the commit did nothing".
    func testBulkCompleteKeys() throws {
        let data = try Fixtures.object("bulk-complete")
        XCTAssertEqual(data["tasks_affected"] as? Int, 2)
        XCTAssertEqual(data["prompts_considered"] as? Int, 1)
        XCTAssertEqual(data["prompts_did"] as? Int, 0)
    }

    // MARK: POST /api/tasks/bulk/snooze

    /// `APIClient.parseBulkSnoozeResult` reads these four keys through
    /// JSONSerialization and defaults each to 0, like bulk/complete's. The
    /// scenario snoozes an overdue task and gives a dateless one its first
    /// date (both affected), and skips an Urgent task and a reminder.
    func testBulkSnoozeKeys() throws {
        let data = try Fixtures.object("bulk-snooze")
        XCTAssertEqual(data["tasks_affected"] as? Int, 2)
        XCTAssertEqual(data["skipped_urgent"] as? Int, 1)
        XCTAssertEqual(data["skipped_high"] as? Int, 0)
        XCTAssertEqual(data["snoozed_high"] as? Int, 0)
        // `moved_ids` (2026-10-26): the two it moved — step 8's overdue task
        // and step 9's dateless one — not the Urgent one or the reminder.
        XCTAssertEqual(data["moved_ids"] as? [Int], [107, 108])
        XCTAssertEqual(APIClient.parseBulkSnoozeResult(try Fixtures.data("bulk-snooze")).movedIds, [107, 108])
    }

    /// `POST /api/tasks/bulk/snooze-overdue` with the task queue on: one of
    /// the two moved tasks went to the queue at the day start (`queued`,
    /// `queued_until`), and the server's one line says so (`summary`) — what
    /// the watch's "N to the queue at …" line and the Mac menu bar read.
    func testBulkSnoozeOverdueQueued() throws {
        let raw = try Fixtures.object("bulk-snooze-overdue")
        XCTAssertEqual(raw["queued"] as? Int, 1)
        XCTAssertEqual(raw["queued_until"] as? String, Fixtures.pinnedTimestamp)
        let result = APIClient.parseBulkSnoozeResult(try Fixtures.data("bulk-snooze-overdue"))
        XCTAssertEqual(result.tasksAffected, 2)
        XCTAssertEqual(result.queued, 1)
        XCTAssertEqual(result.queuedUntil, DateHelpers.parseISO(Fixtures.pinnedTimestamp))
        XCTAssertEqual(result.summary, raw["summary"] as? String)
        XCTAssertTrue(result.summary?.contains("Tasks queue") ?? false)
        XCTAssertEqual(result.summaryLines.first, .queued(1, at: result.queuedUntil))
        // Both moved tasks — the queued one included — are in `moved_ids`,
        // the banners a sweep clears; step 9's Urgent task (skipped) is not.
        XCTAssertEqual(raw["moved_ids"] as? [Int], [114, 115])
        XCTAssertEqual(result.movedIds, [114, 115])
        XCTAssertEqual(result.movedIds?.count, result.tasksAffected)
    }

    /// A server from before `moved_ids` (2026-10-26): nil, not empty — the
    /// sweep clears no banner locally, and the watch cache falls back to its
    /// guess. An empty list is a real answer: nothing moved.
    func testBulkSnoozeWithoutMovedIdsDecodesNil() {
        let old = Data(#"{"data":{"tasks_affected":2,"skipped_urgent":0}}"#.utf8)
        XCTAssertNil(APIClient.parseBulkSnoozeResult(old).movedIds)
        let none = Data(#"{"data":{"tasks_affected":0,"moved_ids":[]}}"#.utf8)
        XCTAssertEqual(APIClient.parseBulkSnoozeResult(none).movedIds, [])
    }

    // MARK: GET /api/tasks, /api/time-slots, /api/completions, /api/undo/status

    func testOpenTasks() throws {
        let tasks = try Fixtures.decode(TasksPage.self, "tasks").tasks
        XCTAssertEqual(tasks.map(\.id), [100, 101, 102, 103, 104, 105])
        XCTAssertEqual(tasks.filter(\.isTracked).map(\.id), [101, 102, 103])
        XCTAssertEqual(tasks.filter(\.isReminder).map(\.id), [104, 105])
        XCTAssertEqual(tasks.filter(\.hasNotes).map(\.id), [101], "has_notes derived from the server's notes")
        XCTAssertEqual(tasks.first { $0.id == 104 }?.anchorTime, "08:00")
        XCTAssertNotNil(tasks.first { $0.id == 100 }?.dueDate, "the pinned ISO parses")
        XCTAssertNil(tasks.first { $0.id == 101 }?.dueDate, "a quota has no due date")
        // "Up next": dated, not a reminder, not a quota.
        XCTAssertEqual(WatchSlotLogic.upNextTasks(from: tasks).map(\.id), [100])
    }

    func testTimeSlots() throws {
        let slots = try Fixtures.decode(TimeSlotsPage.self, "time-slots").timeSlots
        XCTAssertEqual(slots.map(\.id), [11, 12, 13, 14, 15])
        XCTAssertEqual(slots.map(\.label), ["Early morning", "Morning", "Midday", "Afternoon", "Evening"])
        XCTAssertEqual(slots.compactMap(\.startMinutes), [420, 540, 720, 960, 1230])
    }

    func testCompletions() throws {
        let completions = try Fixtures.decode(CompletionsPage.self, "completions").completions
        XCTAssertEqual(completions.map(\.id), [501, 502])
        XCTAssertEqual(completions.map(\.taskId), [Fixtures.stretch, Fixtures.plants])
        XCTAssertEqual(completions.map(\.taskTitle), ["Stretch", "Water the plants"])
        XCTAssertEqual(completions.map(\.isReminder), [true, false])
        XCTAssertEqual(completions.map(\.isQuota), [false, false])
        XCTAssertEqual(completions.map(\.projectId), [1, 1])
        XCTAssertNotNil(completions[0].completedDate)
        // Completions carry the attempts at completion (2026-10-12).
        XCTAssertEqual(completions.map(\.attempts), [0, 0])
        let raw = try XCTUnwrap(try Fixtures.object("completions")["completions"] as? [[String: Any]])
        XCTAssertEqual(raw.compactMap { $0["attempts"] as? Int }, completions.map(\.attempts))
    }

    func testUndoStatus() throws {
        let status = try Fixtures.decode(UndoStatusPage.self, "undo-status")
        // An undo-entry placeholder: 903 since the mutations before it carry
        // `undo_id` (2026-10-26) — the bulk complete's own entry.
        XCTAssertEqual(status.latestId, 903)
        // 6 creates + did + progress + bulk complete.
        XCTAssertEqual(status.undoableCount, 9)
        XCTAssertEqual(status.redoableCount, 0)
        // Scoped Undo (2026-10-26): nothing undone yet, so the newest entry is
        // the newest undoable one, and there is no redo.
        XCTAssertTrue(status.scoped)
        XCTAssertEqual(status.newestUndoableId, 903)
        XCTAssertNil(status.nextRedoableId)
        let raw = try Fixtures.object("undo-status")
        XCTAssertTrue(raw.keys.contains("next_redoable_id"), "present, and null")
    }

    /// An older server's status: no ids at all — `scoped` false, so every
    /// surface keeps the count-based buttons and the bare undo.
    func testUndoStatusFromAnOlderServerIsNotScoped() throws {
        let json = #"{"data":{"latest_id":5,"undoable_count":3,"redoable_count":0}}"#
        let status = try JSONDecoder().decode(APIEnvelope<UndoStatusPage>.self, from: Data(json.utf8)).data
        XCTAssertFalse(status.scoped)
        XCTAssertNil(status.newestUndoableId)
    }

    /// `POST /api/undo { id }`'s answer: the entry undone is the consider's
    /// own `undo_id` — what the recorder pushed for it.
    func testUndoById() throws {
        let consider = try Fixtures.data("quota-prompts-consider")
        let ownId = try XCTUnwrap(APIClient.undoId(in: consider), "every native mutation answers undo_id")
        let result = try APIClient.parseUndoRedoResult(try Fixtures.data("undo-by-id"))
        XCTAssertEqual(result.actedId, ownId)
        XCTAssertEqual(result.description, "Considered \"Practice guitar\"")
        XCTAssertEqual(result.undoableCount, 48)
        XCTAssertEqual(result.redoableCount, 1)
        // A mutation that logged nothing answers `undo_id: null`: no own id
        // (the previous one is kept).
        XCTAssertNil(APIClient.undoId(in: try Fixtures.data("notification-action-not-waiting")))
        XCTAssertNotNil(APIClient.undoId(in: try Fixtures.data("notification-action-considered")))
        // Every captured mutation the widgets and the watch send carries it.
        for name in [
            "bulk-complete", "bulk-snooze", "bulk-snooze-overdue", "quota-prompts-did", "quota-prompts-restore",
            "task-progress", "task-segments-consider", "task-segments-target-today-repeating",
            "task-segments-defer-lead",
        ] {
            XCTAssertNotNil(APIClient.undoId(in: try Fixtures.data(name)), name)
        }
    }

    /// The 409 of a stale `POST /api/undo { id }` (the shape PR #390's
    /// integration test asserts): the reason and the newest undoable entry.
    func testUndoConflictParses() {
        let body = #"{"error":"That action was already undone","code":"CONFLICT","details":{"reason":"already_undone","newest_undoable_id":911}}"#
        guard case .conflict(let reason, let newest) = APIClient.parseUndoConflict(
            Data(body.utf8), newestKey: "newest_undoable_id"
        ) else { return XCTFail("a conflict") }
        XCTAssertEqual(reason, .alreadyUndone)
        XCTAssertEqual(newest, 911)
        let redo = #"{"details":{"reason":"not_next","next_redoable_id":null}}"#
        guard case .conflict(let redoReason, let next) = APIClient.parseUndoConflict(
            Data(redo.utf8), newestKey: "next_redoable_id"
        ) else { return XCTFail("a conflict") }
        XCTAssertEqual(redoReason, .notNext)
        XCTAssertNil(next)
    }

    // MARK: The native question (native PR E, 2026-10-26)

    /// The drift guard: native asks EXACTLY the web's question
    /// (`REMINDERS_URL`, `src/lib/reminders-query.ts`), written into the
    /// fixture by the contract writer.
    func testRemindersPathIsTheWebsQuery() throws {
        let raw = try Fixtures.object("reminders-query")
        XCTAssertEqual(APIClient.remindersPath, raw["path"] as? String)
    }

    /// `GET REMINDERS_URL` with the task queue on, after a rich day: every
    /// kind in the server's order, empty ones with no rows (`fill`), a row
    /// done from "Today's pulls" and one whose lead day was deferred, both
    /// left (`handled`), a SEEN safety-net row, a deck row and a Try Tomorrow
    /// row.
    func testRemindersNativeQuestion() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders-native")
        let segments = payload.taskSegments
        XCTAssertEqual(
            segments.map(\.horizon),
            ["deadlines", "queue_today", "queue_previous", "days", "upcoming", "weeks", "months", "eventually"]
        )
        XCTAssertEqual(
            segments.compactMap(\.kind),
            [.deadlines, .queueToday, .queuePrevious, .horizon(.days), .upcoming, .horizon(.weeks),
             .horizon(.months), .horizon(.eventually)],
            "every kind is known"
        )
        XCTAssertEqual(segments.map(\.pageKey), [-16, -17, -18, -10, -14, -11, -12, -13])
        XCTAssertEqual(TaskSegmentDTO.listed(segments).count, 8, "every segment is a page, empty ones too")
        XCTAssertEqual(segments.filter(\.isEmpty).map(\.horizon), ["days", "months", "eventually"])
        XCTAssertEqual(segments.map(\.title)[0...2], ["Task queue · Deadlines", "Task queue · Today's pulls", "Task queue · Previous pulls"])

        // The deadlines page: the seen safety-net row waits, inert; the
        // deferred one LEFT, "· deferred to <its lead day>".
        let deadlines = segments[0]
        let net = try XCTUnwrap(deadlines.tasks.first { $0.id == Fixtures.deadlinePassed })
        XCTAssertEqual(net.state, .waiting)
        XCTAssertTrue(net.safetyNet)
        XCTAssertTrue(net.seen)
        XCTAssertFalse(net.isConsiderable)
        XCTAssertTrue(deadlines.hasWaiting, "the safety net keeps the page open")
        let deferred = try XCTUnwrap(deadlines.tasks.first { $0.id == Fixtures.deadlineWindow })
        XCTAssertEqual(deferred.state, .considered)
        XCTAssertEqual(deferred.left, .deferred)
        XCTAssertEqual(deferred.task.leadFrom, Fixtures.pinnedDate)
        // 2026-01-15 is a Thursday.
        XCTAssertEqual(deferred.leftLabelText, "File the quarterly report\u{00A0}· deferred\u{00A0}to\u{00A0}Thu")
        XCTAssertFalse(deferred.offersTargetToday, "a left row has no controls")
        XCTAssertFalse(deadlines.offersDeferAll)

        // "Today's pulls": the done row LEFT ("· done"); the Try Tomorrow row.
        let today = segments[1]
        let done = try XCTUnwrap(today.tasks.first { $0.id == Fixtures.queueNew })
        XCTAssertEqual(done.state, .considered)
        XCTAssertEqual(done.left, .done)
        XCTAssertEqual(done.leftLabelText, "Call the plumber\u{00A0}· done")
        XCTAssertEqual(ReminderDayProgress.PeriodCount(today).text, "1 of 2", "the left row counts in N and M")
        let tryTomorrow = try XCTUnwrap(today.tasks.first { $0.id == Fixtures.queueTryTomorrow })
        XCTAssertTrue(tryTomorrow.tryTomorrow)
        XCTAssertFalse(done.tryTomorrow)
        XCTAssertFalse(today.offersDeferAll)

        // Upcoming: the deck rows say "On deck tomorrow" (Tomorrow, 2026-10-27).
        let upcoming = segments[4]
        let deck = try XCTUnwrap(upcoming.tasks.first { $0.id == Fixtures.decked })
        XCTAssertEqual(deck.task.onDeckDay, Fixtures.pinnedDate)
        XCTAssertEqual(deck.section, .tomorrow)
        XCTAssertEqual(deck.task.upcomingMeta(section: .tomorrow), "On\u{00A0}deck\u{00A0}tomorrow")
        XCTAssertEqual(deck.task.upcomingMeta(section: .later), "On\u{00A0}deck\u{00A0}Thu\u{00A0}Jan\u{00A0}15")
        XCTAssertEqual(deck.task.upcomingMeta(form: .short, section: .later), "On\u{00A0}deck\u{00A0}Jan\u{00A0}15")

        // The raw keys the DTO reads, so a renamed key can't decode as false.
        let raw = try Fixtures.object("reminders-native")
        let rawSegments = try XCTUnwrap(raw["task_segments"] as? [[String: Any]])
        let rawDeadlines = try XCTUnwrap(rawSegments.first?["tasks"] as? [[String: Any]])
        XCTAssertTrue(rawDeadlines.contains { $0["seen"] as? Bool == true && $0["safety_net"] as? Bool == true })
        XCTAssertTrue(rawDeadlines.contains { $0["segment_left"] as? String == "deferred" })

        // Round-trips through a cache with everything intact.
        let encoded = try JSONEncoder().encode(segments)
        XCTAssertEqual(try JSONDecoder().decode([TaskSegmentDTO].self, from: encoded), segments)
    }

    // MARK: Task segments (2026-10-10)

    /// THE PLAIN FORM a shipped build sends (`?queue=1&deck=1`, no
    /// `deadlines=1`), switch on: no `deadlines` kind, and the three
    /// target-less deadline tasks — the repeat included — in their horizon
    /// segment (Days), never nowhere: the truthful degrade.
    func testRemindersDeadlinesPlainFormKeepsTheRowsInTheirSegment() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders-deadlines-plain")
        XCTAssertFalse(payload.taskSegments.map(\.horizon).contains("deadlines"))
        let days = try XCTUnwrap(payload.taskSegments.first { $0.horizon == "days" })
        XCTAssertEqual(days.horizonValue, .days)
        let ids = Set(days.tasks.map(\.id))
        for id in [Fixtures.deadlineWindow, Fixtures.deadlinePassed, Fixtures.deadlineRepeatTargetless] {
            XCTAssertTrue(ids.contains(id), "task \(id) listed in Days")
        }
        let repeatRow = try XCTUnwrap(days.tasks.first { $0.id == Fixtures.deadlineRepeatTargetless })
        XCTAssertTrue(repeatRow.recurring)
        XCTAssertNil(repeatRow.task.dueAt, "no target of its own")
        XCTAssertEqual(repeatRow.task.deadlineAt, Fixtures.pinnedTimestamp)
        XCTAssertTrue(days.isListed)
    }

    /// THE DEADLINES PAGE (2026-10-22), `GET /api/reminders?…&deadlines=1`:
    /// native draws it since PR E (2026-10-26, `SegmentKind.deadlines`); a
    /// build that predates it still decodes the payload (an unknown kind),
    /// which is why the server sends it only to a caller that opts in (plan
    /// L5). Its rows carry no target, and the one-offs read
    /// `deadline_nag_off` true, so a build from 10-10..10-12 implies no
    /// target of its own.
    func testRemindersDeadlinesPageDecodes() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders-deadlines")
        let page = try XCTUnwrap(payload.taskSegments.first)
        XCTAssertEqual(page.horizon, "deadlines")
        // Native PR E: a kind this build draws — first, its own page key and
        // title, no Defer all, finishing in its teal.
        XCTAssertEqual(page.kind, .deadlines)
        XCTAssertEqual(page.pageKey, -16)
        XCTAssertEqual(page.title, "Task queue · Deadlines")
        XCTAssertFalse(page.offersDeferAll)
        XCTAssertNotNil(page.kind?.doneColorHex)
        XCTAssertEqual(page.tasks.map(\.safetyNet), [true, false, false])
        XCTAssertEqual(page.tasks.map(\.seen), [false, false, false])
        XCTAssertTrue(page.tasks.allSatisfy(\.isConsiderable))
        XCTAssertEqual(
            page.tasks.map(\.id),
            [Fixtures.deadlinePassed, Fixtures.deadlineRepeatTargetless, Fixtures.deadlineWindow]
        )
        for row in page.tasks {
            XCTAssertNil(row.task.dueAt, "a deadlines-page row has no target")
            XCTAssertEqual(row.task.deadlineAt, Fixtures.pinnedTimestamp)
            XCTAssertFalse(row.task.targetAuto)
        }
        // `deadline_nag_off` is no longer decoded (this build has no implied
        // target); read it raw — the field the 10-10..10-12 builds decode.
        let raw = try Fixtures.object("reminders-deadlines")
        let rawPage = try XCTUnwrap((raw["task_segments"] as? [[String: Any]])?.first)
        let rawRows = try XCTUnwrap(rawPage["tasks"] as? [[String: Any]])
        let oneOffs = rawRows.filter { $0["rrule"] is NSNull }
        XCTAssertEqual(oneOffs.count, 2)
        XCTAssertTrue(oneOffs.allSatisfy { $0["deadline_nag_off"] as? Bool == true })
        XCTAssertEqual(rawRows.map { $0["safety_net"] as? Bool }, [true, false, false])
        // The other segments are unchanged by the opt-in.
        XCTAssertEqual(
            payload.taskSegments.dropFirst().map(\.horizon),
            ["queue_today", "queue_previous", "upcoming", "weeks"]
        )
    }

    /// `GET /api/reminders` after the segment row was considered: the
    /// top-level `task_segments`, never inside a group.
    func testRemindersTaskSegments() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders-segments")
        XCTAssertEqual(payload.taskSegments.map(\.horizon), ["days"])
        let days = try XCTUnwrap(payload.taskSegments.first)
        XCTAssertEqual(days.horizonValue, .days)
        XCTAssertEqual(days.label, "Days")
        XCTAssertEqual(days.pageKey, -10)
        XCTAssertFalse(days.nudge)
        XCTAssertEqual(days.tasks.map(\.id), [Fixtures.squeakyDoor])
        XCTAssertEqual(days.tasks.map(\.state), [.considered])
        XCTAssertEqual(days.waitingCount, 0)
        XCTAssertEqual(days.consideredTasks.count, 1)
        XCTAssertTrue(days.isListed, "a considered row keeps the segment listed, so it can go green")

        let row = try XCTUnwrap(days.tasks.first).task
        XCTAssertEqual(row.title, "Fix the squeaky door")
        XCTAssertEqual(row.horizon, "days")
        XCTAssertEqual(row.horizonLabel, "Days")
        // With the task queue on (production, 2026-10-22) a deadline with no
        // picked target has NO target at all (the deadlines page) — and this
        // plain request (no `?deadlines=1`) lists it in its horizon segment,
        // the deadline pulling it in.
        XCTAssertNil(row.dueAt)
        XCTAssertEqual(row.deadlineAt, Fixtures.pinnedTimestamp)
        XCTAssertFalse(row.targetAuto)
        XCTAssertEqual(row.attempts, 0)
        XCTAssertNil(row.attemptsLabel)
        XCTAssertNil(row.ageLabel)
        XCTAssertFalse(row.isReminder)

        // Field by field against the raw JSON — a renamed key would otherwise
        // decode silently as nil/false.
        let raw = try Fixtures.object("reminders-segments")
        let rawSegment = try XCTUnwrap((raw["task_segments"] as? [[String: Any]])?.first)
        XCTAssertEqual(rawSegment["horizon"] as? String, "days")
        XCTAssertEqual(rawSegment["waiting"] as? Int, days.waitingCount)
        XCTAssertEqual(rawSegment["considered"] as? Int, days.consideredTasks.count)
        let rawTask = try XCTUnwrap((rawSegment["tasks"] as? [[String: Any]])?.first)
        XCTAssertEqual(rawTask["segment_state"] as? String, "considered")
        XCTAssertEqual(rawTask["horizon"] as? String, row.horizon)
        XCTAssertEqual(rawTask["deadline_at"] as? String, row.deadlineAt)
        XCTAssertTrue(rawTask["target_at"] is NSNull, "target_at mirrors due_at: none")
        XCTAssertEqual(rawTask["target_auto"] as? Bool, row.targetAuto, "no automatic target")
        XCTAssertEqual(rawTask["deadline_nag_off"] as? Bool, true, "older builds imply no target")
        XCTAssertEqual(rawTask["attempts"] as? Int, row.attempts)

        // Segments stay out of every group, and out of every reminders count.
        let groupIds = Set(payload.groups.flatMap { $0.reminders + $0.consideredItems }.map(\.id))
        XCTAssertFalse(groupIds.contains(Fixtures.squeakyDoor))
        XCTAssertFalse(payload.groups.flatMap(\.prompts).contains { $0.taskId == Fixtures.squeakyDoor })
    }

    /// A segment row survives the App Group / watch cache round trip — state
    /// and the new task fields included.
    func testSegmentRowRoundTripsThroughACache() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders-segments")
        let data = try JSONEncoder().encode(payload)
        let back = try JSONDecoder().decode(RemindersPayload.self, from: data)
        XCTAssertEqual(back.taskSegments, payload.taskSegments)
        XCTAssertEqual(back.groups, payload.groups)
    }

    /// An older server (or an older cache) has no `task_segments` at all.
    func testRemindersWithoutSegmentsStillDecode() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders")
        XCTAssertEqual(payload.taskSegments, [])
        XCTAssertEqual(payload.groups.count, 6)
    }

    func testSegmentConsiderResponse() throws {
        let result = try Fixtures.decode(APIClient.SegmentConsiderResult.self, "task-segments-consider")
        XCTAssertEqual(result.considered, 1)
    }

    // MARK: The task queue's panels (task-queue PR 3, docs/TASK-MODEL.md § The task queue)

    /// `GET /api/reminders?queue=1` with the server's task queue on: two
    /// segment kinds, `queue_today` and `queue_previous`, FIRST. Until native
    /// PR E (2026-10-26) this build didn't know them (a future kind, -15);
    /// now they decode as `SegmentKind.queueToday` / `.queuePrevious`.
    func testRemindersQueueSegmentsDecodeAsTheirKinds() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders-queue")
        let horizons = payload.taskSegments.map(\.horizon)
        XCTAssertEqual(Array(horizons.prefix(2)), ["queue_today", "queue_previous"])
        // Native PR E: kinds this build draws, with their own page keys and
        // titles, and no Defer all.
        let expected: [(SegmentKind, Int, String)] = [
            (.queueToday, -17, "Task queue · Today's pulls"), (.queuePrevious, -18, "Task queue · Previous pulls"),
        ]
        for (segment, (kind, key, title)) in zip(payload.taskSegments.prefix(2), expected) {
            XCTAssertEqual(SegmentKind(raw: segment.horizon), kind)
            XCTAssertEqual(segment.kind, kind)
            XCTAssertTrue(segment.kind?.isQueue ?? false)
            XCTAssertNil(segment.horizonValue)
            XCTAssertEqual(segment.pageKey, key)
            XCTAssertEqual(segment.title, title)
            XCTAssertFalse(segment.offersDeferAll)
            XCTAssertEqual(segment.tasks.count, 2)
            XCTAssertEqual(segment.tasks.map(\.state), [.waiting, .waiting])
        }
        let today = payload.taskSegments[0]
        XCTAssertEqual(today.tasks.map(\.task.title), ["Call the plumber", "Sort the receipts"])
        XCTAssertEqual(today.tasks.map(\.recurring), [false, false])
        let previous = payload.taskSegments[1]
        XCTAssertEqual(previous.tasks.map(\.task.title), ["Return the library books", "Water the ferns"])
        XCTAssertEqual(previous.tasks.map(\.recurring), [false, true])
        XCTAssertNil(previous.tasks[0].task.dueAt, "a stripped one-off has no target")
        XCTAssertNotNil(previous.tasks[1].task.dueAt, "a waiting weekly task keeps its next occurrence")
        // The known kinds after them still read as before.
        XCTAssertEqual(payload.taskSegments.dropFirst(2).compactMap(\.kind).count, payload.taskSegments.count - 2)

        // The queue fields the native apps will need later are on every row.
        let raw = try Fixtures.object("reminders-queue")
        let rawSegments = try XCTUnwrap(raw["task_segments"] as? [[String: Any]])
        let rawToday = try XCTUnwrap(rawSegments.first?["tasks"] as? [[String: Any]])
        XCTAssertEqual(rawToday.map { $0["try_tomorrow"] as? Bool }, [false, true])
        XCTAssertEqual(today.tasks.map(\.tryTomorrow), [false, true])
        XCTAssertEqual(rawToday.map { $0["queued_from_due_at"] as? String }, [Fixtures.pinnedTimestamp, Fixtures.pinnedTimestamp])
    }

    // MARK: Upcoming (2026-10-12, docs/TASK-MODEL.md § Upcoming)

    /// `GET /api/reminders` with an Upcoming segment, after Days: a one-off
    /// with a target and deadline, and a repeating task (no Today on its row).
    func testRemindersUpcomingSegment() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders-upcoming")
        XCTAssertEqual(payload.taskSegments.map(\.horizon), ["days", "upcoming"], "Upcoming comes after Days")
        let upcoming = try XCTUnwrap(payload.taskSegments.last)
        XCTAssertEqual(upcoming.kind, .upcoming)
        XCTAssertNil(upcoming.horizonValue)
        XCTAssertEqual(upcoming.label, "Upcoming")
        XCTAssertEqual(upcoming.pageKey, -14)
        XCTAssertFalse(upcoming.nudge)
        XCTAssertEqual(upcoming.tasks.map(\.id), [Fixtures.passport, Fixtures.plantsRecurring])
        XCTAssertEqual(upcoming.tasks.map(\.state), [.waiting, .waiting])
        XCTAssertEqual(upcoming.tasks.map(\.recurring), [false, true])
        XCTAssertEqual(upcoming.tasks.map(\.offersTargetToday), [true, true], "Today on every row since batch 2")
        XCTAssertEqual(upcoming.waitingCount, 2)
        XCTAssertTrue(upcoming.isListed)

        let passport = upcoming.tasks[0].task
        XCTAssertEqual(passport.title, "Renew the passport")
        XCTAssertEqual(passport.dueAt, Fixtures.pinnedTimestamp)
        XCTAssertEqual(passport.deadlineAt, Fixtures.pinnedTimestamp)
        XCTAssertEqual(passport.targetSetAt, Fixtures.pinnedTimestamp)
        XCTAssertNil(passport.rrule)
        XCTAssertNil(passport.horizon)
        let plants = upcoming.tasks[1].task
        XCTAssertEqual(plants.title, "Water the plants")
        XCTAssertEqual(plants.rrule, "FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0")
        XCTAssertEqual(plants.targetSetAt, Fixtures.pinnedTimestamp)
        XCTAssertNil(plants.deadlineAt)

        // The Days row carries the new fields too.
        let days = try XCTUnwrap(payload.taskSegments.first)
        XCTAssertEqual(days.tasks.map(\.id), [Fixtures.squeakyDoor])
        XCTAssertEqual(days.tasks.map(\.recurring), [false])

        // Field by field against the raw JSON — a renamed key would otherwise
        // decode silently through the rrule fallback / nil.
        let raw = try Fixtures.object("reminders-upcoming")
        let rawSegments = try XCTUnwrap(raw["task_segments"] as? [[String: Any]])
        XCTAssertEqual(rawSegments.map { $0["horizon"] as? String }, ["days", "upcoming"])
        let rawUpcoming = try XCTUnwrap(rawSegments.last)
        XCTAssertEqual(rawUpcoming["waiting"] as? Int, upcoming.waitingCount)
        XCTAssertEqual(rawUpcoming["considered"] as? Int, upcoming.consideredTasks.count)
        let rawRows = try XCTUnwrap(rawUpcoming["tasks"] as? [[String: Any]])
        XCTAssertEqual(rawRows.map { $0["recurring"] as? Bool }, [false, true])
        XCTAssertEqual(rawRows.map { $0["target_set_at"] as? String }, [Fixtures.pinnedTimestamp, Fixtures.pinnedTimestamp])
        XCTAssertEqual(rawRows.map { $0["segment_state"] as? String }, ["waiting", "waiting"])

        // Upcoming rows stay out of every group, like every segment's.
        let groupIds = Set(payload.groups.flatMap { $0.reminders + $0.consideredItems }.map(\.id))
        XCTAssertTrue(groupIds.isDisjoint(with: [Fixtures.passport, Fixtures.plantsRecurring]))

        // And it survives the cache round trip, `recurring` included.
        let back = try JSONDecoder().decode(RemindersPayload.self, from: JSONEncoder().encode(payload))
        XCTAssertEqual(back.taskSegments, payload.taskSegments)
        XCTAssertEqual(back.taskSegments.last?.tasks.map(\.recurring), [false, true])
    }

    /// Upcoming's two sections (2026-10-25 on the server; native 2026-10-26):
    /// every Upcoming row's `upcoming_section`, Tomorrow's rows first, a
    /// considered row in its section too; the split's per-section "n of m";
    /// the cache round trip keeps the section; no other kind carries it.
    func testRemindersUpcomingSections() throws {
        let payload = try Fixtures.decode(RemindersPayload.self, "reminders-upcoming-sections")
        let upcoming = try XCTUnwrap(payload.taskSegments.first { $0.kind == .upcoming })
        XCTAssertEqual(
            upcoming.tasks.map(\.id),
            [Fixtures.passport, Fixtures.sectionTomorrow, Fixtures.sectionSeen, Fixtures.sectionLater]
        )
        XCTAssertEqual(upcoming.tasks.map(\.upcomingSection), [.tomorrow, .tomorrow, .later, .later])
        XCTAssertEqual(upcoming.tasks.map(\.state), [.waiting, .waiting, .considered, .waiting])

        let raw = try Fixtures.object("reminders-upcoming-sections")
        let rawSegments = try XCTUnwrap(raw["task_segments"] as? [[String: Any]])
        let rawUpcoming = try XCTUnwrap(rawSegments.first { $0["horizon"] as? String == "upcoming" })
        let rawRows = try XCTUnwrap(rawUpcoming["tasks"] as? [[String: Any]])
        XCTAssertEqual(rawRows.map { $0["upcoming_section"] as? String }, ["tomorrow", "tomorrow", "later", "later"])
        for segment in rawSegments where segment["horizon"] as? String != "upcoming" {
            for row in segment["tasks"] as? [[String: Any]] ?? [] {
                XCTAssertNil(row["upcoming_section"], "only Upcoming rows carry a section")
            }
        }
        for segment in payload.taskSegments where segment.kind != .upcoming {
            XCTAssertTrue(segment.tasks.allSatisfy { $0.upcomingSection == nil })
        }

        let sections = UpcomingSections.split(upcoming.tasks)
        XCTAssertEqual(sections.map(\.section), [.tomorrow, .later])
        XCTAssertEqual(sections.map { $0.waiting.map(\.id) }, [
            [Fixtures.passport, Fixtures.sectionTomorrow], [Fixtures.sectionLater],
        ])
        XCTAssertEqual(sections.map(\.countText), ["0 of 2", "1 of 2"])
        XCTAssertEqual(sections.map(\.finished), [false, false])
        // The segment's own "X of Y" stays whole.
        XCTAssertEqual(ReminderDayProgress.PeriodCount(upcoming).text, "1 of 4")

        let back = try JSONDecoder().decode(RemindersPayload.self, from: JSONEncoder().encode(payload))
        XCTAssertEqual(back.taskSegments, payload.taskSegments)
        XCTAssertEqual(
            back.taskSegments.first { $0.kind == .upcoming }?.tasks.map(\.upcomingSection),
            [.tomorrow, .tomorrow, .later, .later]
        )
    }

    /// `POST /api/task-segments/target-today` on a repeating task: since §6
    /// (2026-10-12) its target moves (the occurrence stays), so it is
    /// targeted, and `skipped_recurring` is present and empty.
    func testTargetTodayRepeatingResponse() throws {
        let result = try Fixtures.decode(APIClient.SegmentTargetResult.self, "task-segments-target-today-repeating")
        XCTAssertEqual(result.affected, 1)
        XCTAssertEqual(result.skippedRecurring, [])
        let raw = try Fixtures.object("task-segments-target-today-repeating")
        XCTAssertEqual(raw["skipped_recurring"] as? [Int], [])
    }

    /// `GET /api/user/preferences` carries the check-in day (Luxon: 6 = Saturday).
    func testPreferencesCheckInDay() throws {
        let page = try Fixtures.decode(UserPreferencesLabelConfigPage.self, "user-preferences")
        XCTAssertEqual(page.checkInDay, 6)
        XCTAssertEqual(try Fixtures.object("user-preferences")["check_in_day"] as? Int, 6)
    }

    /// `GET /api/user/preferences` carries the day boundary ("Day starts at"
    /// PR 3): `rollover_time` (the 03:00 default in the fixture's scenario)
    /// and `week_start`. The writer strips `task_queue` (a server-environment
    /// switch), so it decodes nil here — and nil reads as midnight, what a
    /// server without the switch runs on.
    func testPreferencesDayBoundary() throws {
        let page = try Fixtures.decode(UserPreferencesLabelConfigPage.self, "user-preferences")
        let raw = try Fixtures.object("user-preferences")
        XCTAssertEqual(page.rolloverTime, "03:00")
        XCTAssertEqual(raw["rollover_time"] as? String, "03:00")
        XCTAssertEqual(page.weekStart, "sunday")
        XCTAssertEqual(raw["week_start"] as? String, "sunday")
        XCTAssertNil(page.taskQueue)
        XCTAssertNil(raw["task_queue"])
        XCTAssertEqual(DayStartStore.resolvedDayStart(taskQueue: page.taskQueue, rolloverTime: page.rolloverTime), "00:00")
        XCTAssertEqual(DayStartStore.resolvedDayStart(taskQueue: true, rolloverTime: page.rolloverTime), "03:00")
        XCTAssertEqual(DayStartStore.firstWeekday(for: page.weekStart), 1)
    }

    /// `GET /api/user/preferences` carries the snooze pad's four resolved
    /// preset times (2026-10-21), unlinked in the fixture's scenario.
    func testPreferencesPadPresets() throws {
        let page = try Fixtures.decode(UserPreferencesLabelConfigPage.self, "user-preferences")
        let presets = try XCTUnwrap(page.padPresets)
        XCTAssertEqual(presets.map(\.time), ["09:00", "12:00", "16:00", "20:30"])
        XCTAssertEqual(presets.map(\.slotId), [nil, nil, nil, nil])
        XCTAssertTrue(PadPresetStore.isUsable(presets))
        let raw = try XCTUnwrap(try Fixtures.object("user-preferences")["pad_presets"] as? [[String: Any]])
        XCTAssertEqual(raw.map { $0["time"] as? String }, ["09:00", "12:00", "16:00", "20:30"])
        for entry in raw {
            XCTAssertTrue(entry.keys.contains("slot_id"))
            XCTAssertTrue(entry["slot_id"] is NSNull)
        }
    }

    /// Every task in every fixture carries the task-model fields now.
    func testOpenTasksCarryTheTaskModelFields() throws {
        let raw = try XCTUnwrap(try Fixtures.object("tasks")["tasks"] as? [[String: Any]])
        for task in raw {
            for key in [
                "target_at", "deadline_at", "horizon", "target_set_at", "target_auto", "occurrence_at", "attempts",
                "attempts_counted_through", "attempts_label", "attempts_offer", "age_label", "growth_kept_at",
            ] {
                XCTAssertTrue(task.keys.contains(key), "task \(task["id"] ?? "?") lacks \(key)")
            }
            XCTAssertEqual(task["target_at"] as? String, task["due_at"] as? String, "target_at == due_at")
            // No snooze state since 2026-10-12 (§6).
            XCTAssertFalse(task.keys.contains("is_snoozed"))
            XCTAssertFalse(task.keys.contains("snooze_count"))
        }
        let tasks = try Fixtures.decode(TasksPage.self, "tasks").tasks
        let dated = try XCTUnwrap(tasks.first { $0.id == Fixtures.stretch })
        XCTAssertEqual(dated.targetSetAt, Fixtures.pinnedTimestamp)
        XCTAssertNil(dated.horizon)
        XCTAssertNil(dated.horizonLabel, "unset shows as nothing, never as Weeks")
        // A repeating task's scheduled occurrence, apart from its target (§6).
        XCTAssertEqual(dated.occurrenceAt, Fixtures.pinnedTimestamp)
        XCTAssertFalse(dated.targetAuto)
        XCTAssertEqual(dated.attempts, 0)
        XCTAssertNil(dated.attemptsLabel)
        let rawStretch = try XCTUnwrap(raw.first { $0["id"] as? Int == Fixtures.stretch })
        XCTAssertEqual(rawStretch["occurrence_at"] as? String, dated.occurrenceAt)
    }

    // MARK: The two badges (2026-10-12, task-badges.json)

    /// `GET /api/tasks/{id}` for three tasks: undated and a month old (age),
    /// over target on three days with no deadline (offer "remove"), and the
    /// same with a deadline (offer "remove" since 2026-10-22). Values, then each against its raw
    /// key — the DTO defaults every one of these, so a renamed key would
    /// otherwise decode as nil/0 and the badge would silently vanish.
    func testTaskBadges() throws {
        let data = try Fixtures.data("task-badges")
        let envelopes = try JSONDecoder().decode([String: APIEnvelope<TaskDTO>].self, from: data)
        XCTAssertEqual(Set(envelopes.keys), ["age", "attempts", "attempts_deadline"])
        let age = try XCTUnwrap(envelopes["age"]).data
        let attempts = try XCTUnwrap(envelopes["attempts"]).data
        let deadline = try XCTUnwrap(envelopes["attempts_deadline"]).data

        XCTAssertEqual(age.title, "Clear out the garage")
        XCTAssertNil(age.dueAt)
        XCTAssertEqual(age.ageLabel, ">1 mo")
        XCTAssertEqual(age.attempts, 0)
        XCTAssertNil(age.attemptsLabel)
        XCTAssertNil(age.attemptsOffer)
        XCTAssertNil(TargetAge.attemptsBadge(age))
        XCTAssertEqual(age.segmentMeta(segmentHorizon: "weeks"), ">1\u{00A0}mo", "the age chip ends the row's words")

        XCTAssertEqual(attempts.title, "Oil the hinges")
        XCTAssertEqual(attempts.attempts, 3)
        XCTAssertEqual(attempts.attemptsCountedThrough, Fixtures.pinnedDate)
        XCTAssertEqual(attempts.attemptsLabel, "3×")
        XCTAssertEqual(attempts.attemptsOffer, "remove")
        XCTAssertNil(attempts.ageLabel)
        XCTAssertFalse(attempts.targetAuto)
        XCTAssertNil(attempts.occurrenceAt)
        XCTAssertNil(attempts.growthKeptAt)
        XCTAssertEqual(TargetAge.attemptsBadge(attempts), "3×")
        XCTAssertEqual(TargetAge.tone(attempts: attempts.attempts), .medium)

        XCTAssertEqual(deadline.title, "Book the inspection")
        XCTAssertEqual(deadline.deadlineAt, Fixtures.pinnedTimestamp)
        XCTAssertEqual(deadline.attemptsLabel, "3×")
        // "Back to auto" went 2026-10-22 (the deadlines page): Remove target.
        XCTAssertEqual(deadline.attemptsOffer, "remove")

        let raw = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: [String: Any]])
        for (name, task) in [("age", age), ("attempts", attempts), ("attempts_deadline", deadline)] {
            let fields = try XCTUnwrap(raw[name]?["data"] as? [String: Any], name)
            XCTAssertEqual(fields["attempts"] as? Int, task.attempts, name)
            XCTAssertEqual(fields["attempts_counted_through"] as? String, task.attemptsCountedThrough, name)
            XCTAssertEqual(fields["attempts_label"] as? String, task.attemptsLabel, name)
            XCTAssertEqual(fields["attempts_offer"] as? String, task.attemptsOffer, name)
            XCTAssertEqual(fields["age_label"] as? String, task.ageLabel, name)
            XCTAssertEqual(fields["growth_kept_at"] as? String, task.growthKeptAt, name)
            XCTAssertEqual(fields["target_auto"] as? Bool, task.targetAuto, name)
            XCTAssertEqual(fields["occurrence_at"] as? String, task.occurrenceAt, name)
        }

        // The cache round trip keeps every badge field.
        let back = try JSONDecoder().decode(TaskDTO.self, from: JSONEncoder().encode(deadline))
        XCTAssertEqual(back, deadline)
    }

    // MARK: Deadline-anchored repeats (2026-10-21)

    /// `task-deadline-anchored.json`: a repeat whose rule walks its DEADLINE
    /// (`repeat_anchor: deadline`) — the server's three new fields, which the
    /// DTO doesn't decode (nothing native reads them), and the fields it does:
    /// `due_at` is the derived target, `deadline_at` equals `occurrence_at`.
    /// An older build decodes it like any repeating task with a deadline.
    func testDeadlineAnchoredRepeat() throws {
        let task = try Fixtures.decode(TaskDTO.self, "task-deadline-anchored")
        XCTAssertEqual(task.id, Fixtures.deadlineRepeat)
        XCTAssertEqual(task.title, "Lock the timesheet")
        XCTAssertEqual(task.rrule, "FREQ=DAILY;INTERVAL=7;BYHOUR=17;BYMINUTE=0")
        XCTAssertEqual(task.dueAt, Fixtures.pinnedTimestamp)
        XCTAssertEqual(task.deadlineAt, Fixtures.pinnedTimestamp)
        XCTAssertEqual(task.occurrenceAt, task.deadlineAt, "the occurrence IS the deadline")
        XCTAssertFalse(task.targetAuto, "a scheduled target, never the automatic one")
        let raw = try Fixtures.object("task-deadline-anchored")
        XCTAssertEqual(raw["repeat_anchor"] as? String, "deadline")
        XCTAssertEqual(raw["target_days_before"] as? Int, 1)
        XCTAssertEqual(raw["target_time"] as? String, "18:00")
        XCTAssertEqual(raw["due_at"] as? String, task.dueAt)
        XCTAssertEqual(raw["deadline_at"] as? String, task.deadlineAt)
        XCTAssertEqual(raw["occurrence_at"] as? String, task.occurrenceAt)
    }

    // MARK: Interval quotas (2026-10-16)

    /// `task-interval-quota.json`: an every-2-weeks quota as GET
    /// /api/tasks/{id} returns it — the served period fields, decoded, and
    /// field by field against the raw JSON (a renamed key would decode nil).
    func testIntervalQuotaTask() throws {
        let task = try Fixtures.decode(TaskDTO.self, "task-interval-quota")
        XCTAssertEqual(task.title, "Deep-clean the oven")
        XCTAssertEqual(task.rrule, "FREQ=WEEKLY;INTERVAL=2")
        XCTAssertTrue(task.isTracked)
        XCTAssertEqual(task.progressPeriodStart, Fixtures.pinnedTimestamp, "anchored at create")
        XCTAssertEqual(task.progressPeriodEnd, Fixtures.pinnedTimestamp)
        XCTAssertEqual(task.periodInterval, 2)
        XCTAssertEqual(task.periodLastDay, Fixtures.pinnedDate)
        XCTAssertEqual(task.periodLabel, Fixtures.pinnedPeriodLabel)
        XCTAssertEqual(QuotaRules.interval(of: task), 2)
        XCTAssertEqual(QuotaPeriodGroup.of(task), QuotaPeriodGroup(key: .weekly, interval: 2))

        let raw = try Fixtures.object("task-interval-quota")
        XCTAssertEqual(raw["progress_period_end"] as? String, task.progressPeriodEnd)
        XCTAssertEqual(raw["period_interval"] as? Int, task.periodInterval)
        XCTAssertEqual(raw["period_last_day"] as? String, task.periodLastDay)
        XCTAssertEqual(raw["period_label"] as? String, task.periodLabel)

        // The cache round trip keeps every period field.
        let back = try JSONDecoder().decode(TaskDTO.self, from: JSONEncoder().encode(task))
        XCTAssertEqual(back, task)
    }

    /// `reminders-interval.json`: the every-2-weeks quota's prompt carries the
    /// same period, and every surface's word for it is the served end.
    func testIntervalQuotaPrompt() throws {
        let prompts = try Fixtures.prompts("reminders-interval")
        XCTAssertEqual(prompts.count, 5)
        let prompt = try XCTUnwrap(prompts.first { $0.taskId == Fixtures.fortnightly })
        XCTAssertEqual(prompt.title, "Deep-clean the oven")
        XCTAssertEqual(prompt.period, "WEEKLY", "the bare FREQ, as older builds read it")
        XCTAssertEqual(prompt.periodInterval, 2)
        XCTAssertEqual(prompt.periodEnd, Fixtures.pinnedTimestamp)
        XCTAssertEqual(prompt.periodLastDay, Fixtures.pinnedDate)
        XCTAssertEqual(prompt.periodLabel, Fixtures.pinnedPeriodLabel)
        XCTAssertEqual(prompt.segmentWord, "by\u{00A0}Jan\u{00A0}15", "unbreakable")
        XCTAssertEqual(prompt.countText, "0/1\u{00A0}by\u{00A0}Jan\u{00A0}15")
        XCTAssertEqual(prompt.spokenCount, "0 of 1 by Jan 15")
        XCTAssertEqual(prompt.compactPeriodWord, "1/15")
        // The optimistic rebuilds keep the period.
        XCTAssertEqual(prompt.handled(did: true).periodLabel, prompt.periodLabel)
        XCTAssertEqual(prompt.handled(did: true).putBack().periodEnd, prompt.periodEnd)

        // An interval-1 quota beside it keeps its own word.
        let run = try XCTUnwrap(prompts.first { $0.taskId == Fixtures.weekly })
        XCTAssertNil(run.periodLabel)
        XCTAssertEqual(run.segmentWord, "week")
    }

    // MARK: GET /api/tasks/counts (the foreground badge)

    func testTaskCounts() throws {
        let counts = try Fixtures.decode(TaskCountsPage.self, "task-counts")
        // User B's seeded task plus the one three days late; quotas and
        // reminders are not counted.
        XCTAssertEqual(counts.total, 2)
        XCTAssertEqual(counts.overdue, 1, "the badge number")
        XCTAssertEqual(counts.today, 0)
        let raw = try Fixtures.object("task-counts")
        XCTAssertEqual(Set(raw.keys), ["total", "overdue", "today"])
    }

    // MARK: POST /api/notifications/actions — done with day (REMINDER_NAG's Considered)

    /// Another day's banner: `considered: false`, and nothing else — no
    /// `result`. The DTO defaults a missing `considered` to `true` (an older
    /// server ignores `day`), so the raw key is asserted too: a renamed field
    /// would otherwise read as a success that changed something.
    func testNotificationActionNotWaiting() throws {
        let result = try Fixtures.decode(APIClient.ReminderConsiderResult.self, "notification-action-not-waiting")
        XCTAssertFalse(result.considered)
        let raw = try Fixtures.object("notification-action-not-waiting")
        // `undo_id` is null (2026-10-26): nothing was logged.
        XCTAssertEqual(Set(raw.keys), ["action", "task_id", "considered", "undo_id"])
        XCTAssertTrue(raw["undo_id"] is NSNull)
        XCTAssertEqual(raw["considered"] as? Bool, false)
        XCTAssertEqual(raw["task_id"] as? Int, Fixtures.namedReminder)
    }

    /// Today's day, waiting: `considered: true`, with the done's `result`.
    func testNotificationActionConsidered() throws {
        let result = try Fixtures.decode(APIClient.ReminderConsiderResult.self, "notification-action-considered")
        XCTAssertTrue(result.considered)
        let raw = try Fixtures.object("notification-action-considered")
        XCTAssertEqual(raw["considered"] as? Bool, true)
        XCTAssertEqual(raw["action"] as? String, "done")
        XCTAssertEqual(raw["task_id"] as? Int, Fixtures.namedReminder)
        let task = try XCTUnwrap((raw["result"] as? [String: Any])?["task"] as? [String: Any])
        XCTAssertEqual(task["id"] as? Int, Fixtures.namedReminder)
        XCTAssertEqual(task["done"] as? Bool, true)
    }

    /// A body with no `considered` (a server from before the day guard, which
    /// ignores `day` and does a plain done) reads as `true`: it acted.
    func testReminderConsiderResultWithoutTheFieldIsTrue() throws {
        let data = Data(#"{"data":{"action":"done","task_id":1}}"#.utf8)
        let result = try JSONDecoder().decode(APIEnvelope<APIClient.ReminderConsiderResult>.self, from: data).data
        XCTAssertTrue(result.considered)
    }
}
