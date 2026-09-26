#if DEBUG
import SwiftUI
import WidgetKit

// MARK: - Notes-glyph previews (2026-09-25, realistic sample data)
//
// Realistic sample reminders and quota prompts for the notes glyph after a
// row's title: invented titles, with the shape of a real account's
// `GET /api/reminders` at 1:47 PM (six slots, the same row counts per slot,
// the same title lengths, notes flags, periods and stripe colors). Kept as
// the API's own JSON and decoded by the real `Decodable` inits, so the
// server's `notes` -> `TaskDTO.hasNotes` and `has_notes` ->
// `QuotaPromptDTO.hasNotes` paths are what these renders exercise; a
// non-blank `notes` is a placeholder. When `ios/Previews.local/reminders.json`
// exists (`PreviewLocalData`, gitignored), these previews render that instead.
//
// One block per (slot or scope, page): the page is read from the App Group
// at render time and the store keeps ONE (slot/scope, page) pair per kind.
// Medium and Small have no pager, so their blocks carry one timeline entry
// per slot/scope instead (render with `timelineIndex`). The "done shown"
// blocks pass page 99, which clamps to the list's last page.
private enum NotesGlyphPreviewData {
    /// The sample's instant — 2026-09-25 1:47 PM CDT.
    static let now = DateHelpers.parseISO("2026-09-25T18:47:00Z") ?? Date()

    private static func decode<T: Decodable>(_ json: String) -> T {
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
    static let groups: [ReminderGroupDTO] = PreviewLocalData.reminderGroups ?? decode(#"[{"slot":{"id":11,"label":"Early morning","start_time":"06:30"},"reminders":[],"considered":9,"considered_items":[{"id":24073,"project_id":1,"title":"Water the herb garden","priority":0,"due_at":"2026-09-27T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":23432,"project_id":4434,"title":"Open blinds (morning)","priority":0,"due_at":"2026-09-27T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":218,"project_id":1,"title":"A calm start to the morning sets up the rest of it","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":208,"project_id":1,"title":"Treat each mistake as a clue to what’s worth learning?","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":168,"project_id":4434,"title":"Plant care (Water, Mist, Turn to sun)","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":24,"project_id":1,"title":"Morning = Focus, Afternoon = Meetings, Evening = Rest","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":604,"project_id":4434,"title":"Breakfast ( Oatmeal, Berries, Walnuts )","priority":2,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":223,"project_id":1,"title":"Sit tall at the desk and let the shoulders drop and relax","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":64,"project_id":1,"title":"Practice the new song slowly, one phrase at a time, noticing where the breath runs short and marking it on the sheet before trying the whole verse again. Then play it once through without stopping, record it, and listen back with fresh ears. (Small daily corrections add up faster than one long weekend session.)","priority":0,"due_at":"2026-09-26T11:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=6;BYMINUTE=30","anchor_time":"06:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]}],"prompts":[{"task_id":152,"title":"Check the smoke alarm","current":0,"target":1,"period":"MONTHLY","stripe_color":"orange","has_notes":false,"prompt_key":"q:152:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":11},{"task_id":193,"title":"Hearty Breakfast","current":0,"target":2,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:193:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":11},{"task_id":295,"title":"Flush the water heater (drain a gallon from the valve)","current":0,"target":1,"period":"MONTHLY","stripe_color":"orange","has_notes":false,"prompt_key":"q:295:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":11},{"task_id":23534,"title":"Run the weekly backup check on the external drive","current":0,"target":1,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:23534:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":11}]},{"slot":{"id":12,"label":"Morning","start_time":"08:30"},"reminders":[],"considered":7,"considered_items":[{"id":24199,"project_id":1,"title":"Refill water?","priority":0,"due_at":"2026-09-27T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":18050,"project_id":4799,"title":"How has the new morning routine felt (calm and useful to start the day?)","priority":0,"due_at":"2026-09-28T13:30:00.000Z","rrule":"FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["admin"],"notes":"(notes)"},{"id":215,"project_id":4434,"title":"Calf raises","priority":0,"due_at":"2026-09-26T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":197,"project_id":4434,"title":"Deep breath (Slow in, hold it gently — good for steady focus)","priority":0,"due_at":"2026-09-26T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":183,"project_id":4434,"title":"Carrot Sticks + Hummus Cup","priority":0,"due_at":"2026-09-26T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":126,"project_id":4434,"title":"Do my stretches","priority":0,"due_at":"2026-09-26T13:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=30","anchor_time":"08:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":2226,"project_id":6,"title":"Check the team inbox","priority":2,"due_at":"2026-09-26T15:00:00.000Z","rrule":"FREQ=DAILY","anchor_time":"10:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["admin"]}],"prompts":[{"task_id":129,"title":"Whole-Grain Meal (e.g. Rice, Barley)","current":0,"target":3,"period":"WEEKLY","stripe_color":null,"has_notes":true,"prompt_key":"q:129:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":3307,"title":"Look for new evening courses — community colleges, library programs, weekend workshops","current":0,"target":1,"period":"WEEKLY","stripe_color":"pink","has_notes":true,"prompt_key":"q:3307:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":309,"title":"Wipe keyboard + mouse + screen","current":0,"target":1,"period":"MONTHLY","stripe_color":"orange","has_notes":false,"prompt_key":"q:309:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":111,"title":"Dust the bookshelf","current":0,"target":1,"period":"MONTHLY","stripe_color":"orange","has_notes":false,"prompt_key":"q:111:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":276,"title":"Vacuum the car mats","current":0,"target":1,"period":"MONTHLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:276:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":255,"title":"Bake bread from scratch (incl. sourdough)","current":3,"target":5,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:255:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12},{"task_id":83,"title":"Piano Scales","current":1,"target":2,"period":"DAILY","stripe_color":"blue","has_notes":false,"prompt_key":"q:83:1:2026-09-25","number":1,"numbers":[1],"considered":true,"done":true,"slot_id":12},{"task_id":103,"title":"Send a thank-you note to someone this week","current":0,"target":2,"period":"WEEKLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:103:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":12}]},{"slot":{"id":13,"label":"Lunchtime","start_time":"11:30"},"reminders":[{"id":2247,"project_id":4832,"title":"Check the community board posts (school, library, town hall)","priority":2,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["ideas"],"notes":"(notes)"},{"id":38,"project_id":4434,"title":"Is the new plant food still working","priority":0,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["social"]},{"id":146,"project_id":4434,"title":"Crossword puzzle time","priority":0,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["social","media"]},{"id":279,"project_id":4434,"title":"Raisins","priority":0,"due_at":"2026-09-26T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":23393,"project_id":1,"title":"Refill water (optional)","priority":0,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":24200,"project_id":1,"title":"Refill water?","priority":0,"due_at":"2026-09-25T16:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=11;BYMINUTE=30","anchor_time":"11:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]}],"considered":0,"considered_items":[],"prompts":[{"task_id":221,"title":"Rowing Sets","current":1,"target":3,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:221:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":13}]},{"slot":{"id":14,"label":"Afternoon","start_time":"16:30"},"reminders":[{"id":12,"project_id":1,"title":"Listening fully is a much kinder way to talk/be","priority":0,"due_at":"2026-09-25T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":127,"project_id":4434,"title":"Remember to notice the day (“what did I notice today?”, “what am I going to look for tomorrow?”)","priority":0,"due_at":"2026-09-25T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["family","mindset"]},{"id":150,"project_id":1,"title":"Make sure there is a group hike or an outdoor weekend activity on the family calendar","priority":0,"due_at":"2026-09-25T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":222,"project_id":1,"title":"“Take care of the minutes, and the hours will take care of themselves.”","priority":0,"due_at":"2026-09-25T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":24074,"project_id":1,"title":"Posture practice (tall spine, soft jaw, shoulders down and back, feet flat on the floor, seated)","priority":0,"due_at":"2026-09-26T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":24075,"project_id":1,"title":"Evening Herbal Tea (Chamomile, maybe Mint, etc.)","priority":0,"due_at":"2026-09-26T21:30:00.000Z","rrule":"FREQ=DAILY;BYHOUR=16;BYMINUTE=30","anchor_time":"16:30","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]}],"considered":0,"considered_items":[],"prompts":[{"task_id":114,"title":"Evening Tidy-up","current":1,"target":2,"period":"WEEKLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:114:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":83,"title":"Piano Scales","current":1,"target":2,"period":"DAILY","stripe_color":"blue","has_notes":false,"prompt_key":"q:83:2:2026-09-25","number":2,"numbers":[2],"considered":false,"done":false,"slot_id":14},{"task_id":192,"title":"Sort the recycling (chore)","current":0,"target":5,"period":"WEEKLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:192:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":163,"title":"Posture practice (tall spine, soft jaw, shoulders down and back, feet flat on the floor, seated)","current":0,"target":4,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:163:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":116,"title":"Fresh Fruit Bowl","current":1,"target":3,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:116:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":132,"title":"Evening Herbal Tea (Chamomile, maybe Mint, etc.)","current":0,"target":3,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:132:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":24201,"title":"Morning tea (green or jasmine)","current":0,"target":4,"period":"WEEKLY","stripe_color":"blue","has_notes":false,"prompt_key":"q:24201:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":21771,"title":"Frisbee Toss at the Park","current":0,"target":1,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:21771:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14},{"task_id":605,"title":"Do a jigsaw puzzle after dinner","current":0,"target":1,"period":"WEEKLY","stripe_color":"purple","has_notes":false,"prompt_key":"q:605:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":14}]},{"slot":{"id":21,"label":"Wind-down","start_time":"20:15"},"reminders":[{"id":24202,"project_id":1,"title":"10 min of tidying before bed","priority":0,"due_at":"2026-09-26T01:15:00.000Z","rrule":"FREQ=DAILY;BYHOUR=20;BYMINUTE=15","anchor_time":"20:15","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":24203,"project_id":1,"title":"Ask at dinner: “what made you laugh today?\"","priority":0,"due_at":"2026-09-26T01:15:00.000Z","rrule":"FREQ=DAILY;BYHOUR=20;BYMINUTE=15","anchor_time":"20:15","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]}],"considered":0,"considered_items":[],"prompts":[]},{"slot":{"id":15,"label":"Evening","start_time":"21:00"},"reminders":[{"id":19,"project_id":1,"title":"Only one screen at a time (and put it away at nine?)","priority":0,"due_at":"2026-09-14T02:00:00.000Z","rrule":"FREQ=WEEKLY;BYDAY=FR,SU;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":41,"project_id":4434,"title":"Pack lunches","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":44,"project_id":1,"title":"A short walk after dinner might help settle the mind at night","priority":0,"due_at":"2026-09-26T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":70,"project_id":4434,"title":"Box breathing to wind down (use timer)","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health","mindset"]},{"id":94,"project_id":4434,"title":"Hip stretch (desk day)","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":136,"project_id":1,"title":"Fill the house with good music and curious people. Borrow books, try new recipes, play board games — whatever keeps it lively. Provides learning + a steady source of calm","priority":0,"due_at":"2026-09-26T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[]},{"id":273,"project_id":4434,"title":"Evening wind-down routine (after dishes) (finish with a warm drink)","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":["health"]},{"id":3093,"project_id":1,"title":"Ask myself: “What can I let go of?”","priority":0,"due_at":"2026-09-25T02:00:00.000Z","rrule":"FREQ=DAILY;BYHOUR=21;BYMINUTE=0","anchor_time":"21:00","progress_target":1,"progress_current":0,"is_tracked":false,"is_reminder":true,"labels":[],"notes":"(notes)"}],"considered":0,"considered_items":[],"prompts":[{"task_id":160,"title":"Yogurt parfait","current":0,"target":2,"period":"WEEKLY","stripe_color":null,"has_notes":false,"prompt_key":"q:160:0:2026-09-25","number":null,"numbers":null,"considered":false,"done":false,"slot_id":15}]}]"#)

    /// Slot keys in `groups` order — `timelineIndex` n shows slot n.
    static var slotKeys: [Int] { groups.map { $0.slot?.id ?? -1 } }

    static func reminders(slotIndex: Int) -> RemindersEntry {
        RemindersEntry(
            date: now, groups: groups, slotIndex: max(0, min(slotIndex, groups.count - 1)),
            staleSince: nil, isSignedOut: false,
            canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    /// Page `page` of the slot at `slotIndex` — the store keeps ONE (slot,
    /// page) pair, so a paged block shows one slot. Clamped, so local data
    /// with fewer slots still renders.
    static func prepareReminders(page: Int, slotIndex: Int, showCompleted: Bool = false) {
        let key = slotKeys[max(0, min(slotIndex, slotKeys.count - 1))]
        WidgetStore.setShowCompleted(showCompleted, for: RemindersWidget.kind)
        WidgetStore.setRemindersPage(page, for: key)
    }
}

#Preview("Notes — Reminders Large, Early morning page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotIndex: 0)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
}

#Preview("Notes — Reminders Large, Early morning page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotIndex: 0)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
}

#Preview("Notes — Reminders Large, Early morning page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 2, slotIndex: 0)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
}

#Preview("Notes — Reminders Large, Morning page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotIndex: 1)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Morning page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotIndex: 1)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Morning page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 2, slotIndex: 1)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Morning page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 3, slotIndex: 1)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Lunchtime page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotIndex: 2)
    NotesGlyphPreviewData.reminders(slotIndex: 2)
}

#Preview("Notes — Reminders Large, Lunchtime page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotIndex: 2)
    NotesGlyphPreviewData.reminders(slotIndex: 2)
}

#Preview("Notes — Reminders Large, Afternoon page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Afternoon page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Afternoon page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 2, slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Afternoon page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 3, slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Afternoon page 5", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 4, slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Afternoon page 6", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 5, slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Afternoon page 7", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 6, slotIndex: 3)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Wind-down page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotIndex: 4)
    NotesGlyphPreviewData.reminders(slotIndex: 4)
}

#Preview("Notes — Reminders Large, Evening page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotIndex: 5)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Evening page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 1, slotIndex: 5)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Evening page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 2, slotIndex: 5)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Evening page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 3, slotIndex: 5)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Large, Early morning, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotIndex: 0, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 0)
}

#Preview("Notes — Reminders Large, Morning, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotIndex: 1, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Lunchtime, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotIndex: 2, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 2)
}

#Preview("Notes — Reminders Large, Afternoon, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotIndex: 3, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 3)
}

#Preview("Notes — Reminders Large, Wind-down, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotIndex: 4, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 4)
}

#Preview("Notes — Reminders Large, Evening, done shown, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 99, slotIndex: 5, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 5)
}

#Preview("Notes — Reminders Medium", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotIndex: 0)
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
    let _ = NotesGlyphPreviewData.prepareReminders(page: 0, slotIndex: 0)
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
    let _ = NotesGlyphPreviewData.prepareReminders(page: 4, slotIndex: 1, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#Preview("Notes — Reminders Large, Morning, done shown, page 6", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = NotesGlyphPreviewData.prepareReminders(page: 5, slotIndex: 1, showCompleted: true)
    NotesGlyphPreviewData.reminders(slotIndex: 1)
}

#endif
