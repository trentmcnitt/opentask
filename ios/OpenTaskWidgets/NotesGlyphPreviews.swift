#if DEBUG
import SwiftUI
import WidgetKit

// MARK: - Notes-glyph previews (2026-09-25, real-data snapshot)
//
// Trent's REAL reminders and quota prompts, read-only from production
// (GET /api/reminders) at 1:47 PM on 2026-09-25, for the notes glyph after
// a row's title. (The Tasks widget was rendered from the same snapshot's
// /api/tasks, but that corpus is deliberately NOT committed: open task
// titles carry third-party names, phone numbers and account details this
// public repo has no business holding.) Kept as the API's
// own JSON and decoded by the real `Decodable` inits, so the server's
// `notes` -> `TaskDTO.hasNotes` and `has_notes` -> `QuotaPromptDTO.hasNotes`
// paths are what these renders exercise. The notes TEXT is not here: a
// non-blank `notes` is replaced by a placeholder before this file was
// generated. Titles are verbatim (see `RemindersWidget.swift`'s preview
// header for why real titles, and why one `#Preview` block per store state).
//
// One block per (slot or scope, page): the page is read from the App Group
// at render time and the store keeps ONE (slot/scope, page) pair per kind.
// Medium and Small have no pager, so their blocks carry one timeline entry
// per slot/scope instead (render with `timelineIndex`). The "done shown"
// blocks pass page 99, which clamps to the list's last page.
private enum NotesGlyphPreviewData {
    /// The snapshot's instant — 2026-09-25 1:47 PM CDT.
    static let now = DateHelpers.parseISO("2026-09-25T18:47:00Z") ?? Date()

    private static func decode<T: Decodable>(_ json: String) -> T {
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
    static let groups: [ReminderGroupDTO] = decode(#"[{"slot":{"id":11,"label":"Early morning","start_time":"06:30"},"reminders":[],"considered":9,"considered_items":[{"id":24073,"project_id":1,"title":"Cook daily vegetables","priority":0,"due_at":"2026-09-27T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":23432,"project_id":4434,"title":"Cold Shower (morning)","priority":0,"due_at":"2026-09-27T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":218,"project_id":1,"title":"Good form uses the full body to accomplish the task","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":208,"project_id":1,"title":"Think of improvement as fun to see what’s possible?","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":168,"project_id":4434,"title":"Skin care (Cleanse, Moisturize, SPF)","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":24,"project_id":1,"title":"Yesterday = Lesson, Tomorrow = Plan, Today = Practice","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":604,"project_id":4434,"title":"Supplements ( Vitamin C, Zinc, Magnesium )","priority":2,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":223,"project_id":1,"title":"Walk and move in a way that keeps the whole body loose","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":64,"project_id":1,"title":"Learning a physical skill needs a feedback loop: watch, listen and adjust while doing it, so the thinking part of the brain can guide the body. Record, review, repeat, and notice what changed each time. (That is how practice turns into progress, one small correction at a time.) Keep sessions short and specific.","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]}],"prompts":[{"task_id":152,"title":"Charge jump starter","current":0,"target":1,"period":"MONTHLY","stripe_color":"orange","has_notes":false,"prompt_key":"q:152:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":11},{"task_id":193,"title":"Protein Breakfast","current":0,"target":2,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:193:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":11},{"task_id":295,"title":"Reset the router (power everything off for 10 sec)","current":0,"target":1,"period":"MONTHLY","stripe_color":"orange","has_notes":false,"prompt_key":"q:295:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":11},{"task_id":23534,"title":"Run the weekly maintenance checklist in a fresh chat","current":0,"target":1,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:23534:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":11}]},{"slot":{"id":12,"label":"Morning","start_time":"08:30"},"reminders":[],"considered":7,"considered_items":[{"id":24199,"project_id":1,"title":"Stretch break?","priority":0,"due_at":"2026-09-27T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":18050,"project_id":4799,"title":"How has the assistant voice been (pleasant and effective to talk with?)","priority":0,"due_at":"2026-09-28T13:30:00.000Z","rrule":"FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["hub"],"notes":"(notes)"},{"id":215,"project_id":4434,"title":"Wall pushups","priority":0,"due_at":"2026-09-26T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":197,"project_id":4434,"title":"Eye rest (Relax into it, hold it steady — good for presence)","priority":0,"due_at":"2026-09-26T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":183,"project_id":4434,"title":"Mixed Nuts + Pumpkin Seeds","priority":0,"due_at":"2026-09-26T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":126,"project_id":4434,"title":"Do my mobility","priority":0,"due_at":"2026-09-26T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":2226,"project_id":6,"title":"Check GitHub issues","priority":2,"due_at":"2026-09-26T15:00:00.000Z","rrule":"FREQ=DAILY","anchor_time":"10:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["hub"]}],"prompts":[{"task_id":129,"title":"High-Fiber Food (e.g. Bran, Oats)","current":0,"target":3,"period":"WEEKLY","stripe_color":null,"has_notes":true,"prompt_key":"q:129:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":3307,"title":"Check for new certifications — vendor academies, platform certs, automation credentials","current":0,"target":1,"period":"WEEKLY","stripe_color":"pink","has_notes":true,"prompt_key":"q:3307:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":309,"title":"Clean earbuds + phone speakers","current":0,"target":1,"period":"MONTHLY","stripe_color":"orange","has_notes":false,"prompt_key":"q:309:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":111,"title":"Clean bedroom fans","current":0,"target":1,"period":"MONTHLY","stripe_color":"orange","has_notes":false,"prompt_key":"q:111:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":276,"title":"Clean the car seats","current":0,"target":1,"period":"MONTHLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:276:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":255,"title":"Cook daily vegetables (incl. black beans)","current":3,"target":5,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:255:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":83,"title":"Daily Walks","current":1,"target":2,"period":"DAILY","stripe_color":"blue","has_notes":false,"prompt_key":"q:83:1:2026-09-25","number":1,"numbers":[1],"considered":true,"done":true,"slot_id":12},{"task_id":103,"title":"Say something kind to someone every day","current":0,"target":2,"period":"WEEKLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:103:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12}]},{"slot":{"id":13,"label":"Lunchtime","start_time":"11:30"},"reminders":[{"id":2247,"project_id":4832,"title":"Check all public profile pages (website, GitHub, portfolio)","priority":2,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["ideas"],"notes":"(notes)"},{"id":38,"project_id":4434,"title":"Is the vinegar rinse still working","priority":0,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["relationships"]},{"id":146,"project_id":4434,"title":"Chess puzzle training","priority":0,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["relationships","media"]},{"id":279,"project_id":4434,"title":"Almonds","priority":0,"due_at":"2026-09-26T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":23393,"project_id":1,"title":"Stretch break (optional)","priority":0,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":24200,"project_id":1,"title":"Stretch break?","priority":0,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]}],"considered":0,"considered_items":[],"prompts":[{"task_id":221,"title":"Weight Lift","current":1,"target":3,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:221:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":13}]},{"slot":{"id":14,"label":"After School","start_time":"16:30"},"reminders":[{"id":12,"project_id":1,"title":"Being patient is a much happier way to live/be","priority":0,"due_at":"2026-09-25T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":127,"project_id":4434,"title":"Remember to enjoy the day (“am I enjoying my day?”, “what am I going to do to enjoy my day?”)","priority":0,"due_at":"2026-09-25T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["kids","mindset"]},{"id":150,"project_id":1,"title":"Make sure there is a team sport or a hand-eye coordination activity on the calendar","priority":0,"due_at":"2026-09-25T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":222,"project_id":1,"title":"“Do the small things well, and the big things take care of themselves.”","priority":0,"due_at":"2026-09-25T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":24074,"project_id":1,"title":"Balloon breathing practice (slow exhale, relaxed shoulders, breathe into the upper back, seated)","priority":0,"due_at":"2026-09-26T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":24075,"project_id":1,"title":"Daily Supplements (Vit. D, maybe Omega-3, etc.)","priority":0,"due_at":"2026-09-26T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]}],"considered":0,"considered_items":[],"prompts":[{"task_id":114,"title":"Evening Shower","current":1,"target":2,"period":"WEEKLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:114:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":83,"title":"Daily Walks","current":1,"target":2,"period":"DAILY","stripe_color":"blue","has_notes":false,"prompt_key":"q:83:2:2026-09-25","number":2,"numbers":[2],"considered":false,"done":false,"slot_id":14},{"task_id":192,"title":"Empty the dishwasher (chore)","current":0,"target":5,"period":"WEEKLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:192:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":163,"title":"Balloon breathing practice (slow exhale, relaxed shoulders, breathe into the upper back, seated)","current":0,"target":4,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:163:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":116,"title":"Green Vegetables","current":1,"target":3,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:116:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":132,"title":"Daily Supplements (Vit. D, maybe Omega-3, etc.)","current":0,"target":3,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:132:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":24201,"title":"Morning supplements (Vitamin D)","current":0,"target":4,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:24201:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":21771,"title":"Play Catch in the Backyard","current":0,"target":1,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:21771:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":605,"title":"Play a card game after dinner","current":0,"target":1,"period":"WEEKLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:605:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14}]},{"slot":{"id":21,"label":"Pre-bedtime","start_time":"20:15"},"reminders":[{"id":24202,"project_id":1,"title":"10 min of reading before bed","priority":0,"due_at":"2026-09-26T01:15:00.000Z","rrule":"FREQ=DAILY;BYHOUR=20;BYMINUTE=15","anchor_time":"20:15","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":24203,"project_id":1,"title":"Ask at dinner: “what did you do today?\"","priority":0,"due_at":"2026-09-26T01:15:00.000Z","rrule":"FREQ=DAILY;BYHOUR=20;BYMINUTE=15","anchor_time":"20:15","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]}],"considered":0,"considered_items":[],"prompts":[]},{"slot":{"id":15,"label":"Evening","start_time":"21:00"},"reminders":[{"id":19,"project_id":1,"title":"Only light desserts (and earn them with exercise?)","priority":0,"due_at":"2026-09-14T02:00:00.000Z","rrule":"FREQ=WEEKLY;BYDAY=FR,SU;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":41,"project_id":4434,"title":"Laundry fold","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":44,"project_id":1,"title":"Journaling before bed might help clear the mind at night","priority":0,"due_at":"2026-09-26T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":70,"project_id":4434,"title":"Timed breathing to slow down (use app)","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health","mindset"]},{"id":94,"project_id":4434,"title":"Neck stretch (posture)","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":136,"project_id":1,"title":"Surround myself with good books and thoughtful people. Read books, listen to podcasts, play strategy games — whatever it takes. Provides learning + mindset reinforcement","priority":0,"due_at":"2026-09-26T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":273,"project_id":4434,"title":"Evening stretch routine (after mobility) (finish with a long hold)","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":3093,"project_id":1,"title":"Ask myself: “What went well today?”","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[],"notes":"(notes)"}],"considered":0,"considered_items":[],"prompts":[{"task_id":160,"title":"Trail mix bites","current":0,"target":2,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:160:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":15}]}]"#)

    /// Slot keys in `groups` order — `timelineIndex` n shows slot n.
    static let slotKeys: [Int] = [11,12,13,14,21,15]

    static func reminders(slotIndex: Int) -> RemindersEntry {
        RemindersEntry(
            date: now, groups: groups, slotIndex: slotIndex, staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    /// Page `page` of slot `slotKey` — the store keeps ONE (slot, page)
    /// pair, so a paged block shows one slot.
    static func prepareReminders(page: Int, slotKey: Int, showCompleted: Bool = false) {
        WidgetStore.setShowCompleted(showCompleted, for: RemindersWidget.kind)
        WidgetStore.setRemindersPage(page, for: slotKey)
    }
}

#Preview("Notes — Reminders Large, Early morning page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotKey: 11)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
}

#Preview("Notes — Reminders Large, Early morning page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotKey: 11)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
}

#Preview("Notes — Reminders Large, Early morning page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 2, slotKey: 11)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
}

#Preview("Notes — Reminders Large, Morning page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotKey: 12)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Morning page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotKey: 12)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Morning page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 2, slotKey: 12)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Morning page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 3, slotKey: 12)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Lunchtime page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotKey: 13)
    NotesGlyphPreviewData.reminders(slotIndex: 2)
}

#Preview("Notes — Reminders Large, Lunchtime page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotKey: 13)
    NotesGlyphPreviewData.reminders(slotIndex: 2)
}

#Preview("Notes — Reminders Large, After School page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotKey: 14)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, After School page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotKey: 14)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, After School page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 2, slotKey: 14)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, After School page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 3, slotKey: 14)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, After School page 5", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 4, slotKey: 14)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, After School page 6", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 5, slotKey: 14)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, After School page 7", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 6, slotKey: 14)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Pre-bedtime page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotKey: 21)
    NotesGlyphPreviewData.reminders(slotIndex: 4)
}

#Preview("Notes — Reminders Large, Evening page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotKey: 15)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Evening page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotKey: 15)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Evening page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 2, slotKey: 15)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Evening page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 3, slotKey: 15)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Early morning, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotKey: 11, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
}

#Preview("Notes — Reminders Large, Morning, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotKey: 12, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Lunchtime, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotKey: 13, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 2)
}

#Preview("Notes — Reminders Large, After School, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotKey: 14, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Pre-bedtime, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotKey: 21, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 4)
}

#Preview("Notes — Reminders Large, Evening, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotKey: 15, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Medium", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotKey: 11)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
    NotesGlyphPreviewData.reminders(slotIndex: 2)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 4)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Small", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotKey: 11)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
    NotesGlyphPreviewData.reminders(slotIndex: 2)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 4)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Morning, done shown, page 5", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 4, slotKey: 12, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Morning, done shown, page 6", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 5, slotKey: 12, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#endif
