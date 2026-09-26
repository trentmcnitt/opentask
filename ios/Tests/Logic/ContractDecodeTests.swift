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
        XCTAssertEqual(weekly.countText, "1/3\u{00A0}this\u{00A0}week")

        let monthly = try Fixtures.prompt(Fixtures.promptKey(Fixtures.monthly, 0))
        XCTAssertTrue(monthly.isWaiting)
        XCTAssertEqual(monthly.countText, "0/2\u{00A0}this\u{00A0}month")
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
        WidgetStore.saveReminders(try Fixtures.reminders("reminders-initial"))
        let result = try Fixtures.decode(APIClient.PromptActionResult.self, "quota-prompts-did")
        WidgetStore.confirmPromptAction(Fixtures.promptKey(Fixtures.daily, 1), did: true, tasks: result.tasks)

        let cached = try XCTUnwrap(WidgetStore.loadReminders()).value.groups
        let server = try Fixtures.reminders("reminders-after-did")
        XCTAssertEqual(cached, server)
        XCTAssertEqual(cached.map(\.waitingCount), server.map(\.waitingCount))
        XCTAssertEqual(cached.map(\.consideredCount), server.map(\.consideredCount))
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
        WidgetStore.saveReminders(try Fixtures.reminders("reminders-after-did"))
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
        XCTAssertEqual(WatchQuotaPeriod.from(rrule: task.rrule), .weekly)
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
    }

    func testUndoStatus() throws {
        let status = try Fixtures.decode(UndoStatusPage.self, "undo-status")
        XCTAssertEqual(status.latestId, 901)
        // 6 creates + did + progress + bulk complete.
        XCTAssertEqual(status.undoableCount, 9)
        XCTAssertEqual(status.redoableCount, 0)
    }
}
