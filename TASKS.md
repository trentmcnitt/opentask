# TASKS.md

Backlog of improvements, bugs, and ideas. Not prioritized — just a place to capture things so they don't get lost.

---

## Validate semantic correctness of RRULE strings in API

**Area:** API / Validation

`isValidRRule()` in `src/core/recurrence/rrule-builder.ts` validates syntax and value ranges but not semantic correctness. A `FREQ=WEEKLY` rule with no `BYDAY` passes validation and can be created via the API. The UI's recurrence picker always sets `BYDAY` for weekly rules, so this only affects API consumers (Shortcuts, scripts, Claude Code).

**What could go wrong:** A weekly task without `BYDAY` falls back to implicit RFC 5545 behavior (recur on the same weekday as the start date), which may not match what the caller intended. The `anchor_dow` derivation might also behave unexpectedly without an explicit day.

**Potential approach:** Add a semantic validation layer (in `isValidRRule` or as a separate function called during task create/update) that enforces rules like:

- `FREQ=WEEKLY` requires `BYDAY` with at least one day
- `FREQ=MONTHLY` requires `BYMONTHDAY` or `BYDAY`+`BYSETPOS`
- Consider whether this should be a warning (logged) or a hard rejection (400)

**See also:** `src/core/validation/task.ts` (where rrule validation is invoked), `src/core/recurrence/rrule-builder.ts` (where `isValidRRule` lives)
