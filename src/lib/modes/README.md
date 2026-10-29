# Dashboard modes

**Today | Scan | All** (Trent, 2026-10-28). On with the lean row (`useDashboardMode`): the dev build defaults to lean rows (`NEXT_PUBLIC_DEFAULT_TASK_ROWS=lean`); production and CI build without it, so their dashboard is unchanged.

| To change…                         | Edit                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| a mode's sections, their order     | `registry.ts` — one line per section                    |
| what the switch says (Scan → …)    | `MODE_LABELS` in `registry.ts` — the ids never change   |
| a section's rule, order, cap, rows | `sections.ts` — one `SectionDef` each                   |
| a fact a rule reads                | `predicates.ts` (each one the app's existing rule)      |
| the sort pill's sorts              | `sorts.ts`                                              |
| how sections are picked            | `select.ts` (pure; `tests/behavioral/md-modes.test.ts`) |

- **Sections are data.** A `SectionDef` is `{ id, title, match, order, sortable, cap, allowOverlap, rows }`. Nothing that renders knows a section by name.
- **Selection is pure.** `selectSections(tasks, sections, ctx, sort, extra)` → `SectionView[]`: in section order, each takes what it matches minus what an earlier section took (unless it is a complete list, `allowOverlap`), sorts, and shows its cap plus what "Show 5 more" revealed (`extra`). Empty sections are dropped.
- **One list.** The dashboard turns the views into its list's groups (`modeSectionGroups`), so the sections ARE the visual order: the keyboard, shift-click ranges and Cmd+C follow them as drawn, and `TaskList` draws them with its own rows (the lean row, or the compact row for On deck).
- **The day is passed in.** `ModeContext` carries `now`, `timezone` and `dayStart`; every day comparison goes through `src/lib/opentask-day.ts` (TQ-G03, guarded by `tq-day-guard`).
- **A row looks the same in every section.** No per-section words: the heading and the order carry the meaning, and the sort pill names the order.

## The modes

- **Today**: one section, **Today** (title temporary): over target, targeted later today, and the deadline safety net, by time (the target, else the deadline), so past times sit first and a row never jumps sections. Then **On deck**, today's decks in the compact row.
- **Scan** (id `pick-mode`): **Pulled** (in the queue, pulled off a target or a deck in the last 14 OpenTask days; latest pull first, then the latest day missed) · **Newest** (every task) · **Coming up** (a deadline or picked target in the next 3 OpenTask days) · **Horizon: Days, Weeks, Weeks (Unset), Months, Eventually** (the one-offs a horizon governs, `horizonGoverns`; newest first).
- **All**: the dashboard's list as before — its sorts, Now / Newest and Unified — with no Now folds and no On deck section.
- Days shows 10 rows, every other capped section 5; "Show 5 more" / "Show less". Today and On deck show every row. Headings are sticky. Complete lists (Newest, the horizon sections) claim nothing and carry no count; Today, On deck, Pulled and Coming up count their rows.
- **The sort pill** (bottom-left, Today and Scan): Newest / Oldest / Priority / Horizon / Deadline / Target / Last touched. It re-orders the category sections (Pulled, the horizon sections, On deck); the sections that are an order (Today, Newest, Coming up) keep theirs unless "Sort every section" is on. Remembered per device.
- **The project chips** sit above the Filters row in every mode (`FilterBar`'s `projectsOutside`) and narrow every mode.
