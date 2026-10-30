/**
 * THE RULES MAP (2026-10-30): every task-state rule's ONE home in the code.
 *
 * Each id below has exactly one `RULE <ID>:` comment block, at its home: the
 * rule in a sentence or two, why, Trent's ruling and its date where one is
 * recorded (else "none recorded"), and the other places that restate it. Each
 * of those places carries a pointer, `(restates RULE <ID>, home: <path>)`, so
 * a reader there finds the home. docs/TASK-MODEL.md explains the rules and
 * cites them as `(RULE <ID>)`; the code is authoritative.
 *
 * Plain data, read only by the drift guard
 * (tests/behavioral/rl-rule-homes.test.ts), which fails when a block goes
 * missing, moves to another file, loses its Why or Ruling line, drifts more
 * than 40 lines from its symbol, appears twice, or appears without an entry
 * here; when a pointer names the wrong home; when a pinned test is gone; or
 * when the docs cite an id that is not here. To change a rule: change the code
 * and its block together, then this entry and the pins if they moved.
 *
 * - `home`: the file the block is in.
 * - `symbol`: text that appears within 40 lines after the block (the
 *   function, constant or statement the rule lives in).
 * - `pins`: tests that pin the rule, as `tests/behavioral/<file>#<id>` — a
 *   test or describe title that starts with the id. A pin of CURRENT behaviour
 *   on an open issue says so in its title.
 *
 * Two questions are PARKED, never decided here: whether a deck may coexist
 * with a target (I-01, parked at 51%), and write-time exclusivity vs read-time
 * precedence (I-02).
 */

export interface RuleEntry {
  home: string
  symbol: string
  pins: readonly string[]
}

export const RULE_REGISTRY = {
  'HZ-VALUES': {
    home: 'src/lib/task-segments.ts',
    symbol: 'HORIZON_ORDER',
    pins: [
      'tests/behavioral/tm-row-corner.test.ts#TM-RC-010',
      'tests/behavioral/rl-rule-pins.test.ts#RL-HZ-UNSET',
    ],
  },
  'SEG-COUNTS': {
    home: 'src/lib/task-segments.ts',
    symbol: 'segmentCounts',
    pins: [
      'tests/behavioral/tq-day-roster.test.ts#TQ-R02r',
      'tests/behavioral/tq-day-roster.test.ts#TQ-R03r',
    ],
  },
  'SEG-ORDER': {
    home: 'src/lib/task-segments.ts',
    symbol: 'SEGMENT_ORDER',
    pins: [
      'tests/behavioral/tm-fill-segments.test.ts#TM-FILL01',
      'tests/behavioral/tq-panels.test.ts#TQ-P01q',
    ],
  },
  'SEG-NUDGE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'SEGMENT_NUDGE_THRESHOLD',
    pins: ['tests/behavioral/tm-task-model.test.ts#TM-018'],
  },
  'DL-FIELD': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deadline_at',
    pins: ['tests/behavioral/tm-task-model.test.ts#TM-030'],
  },
  'TGT-PICKED': {
    home: 'src/lib/task-segments.ts',
    symbol: 'hasPickedTarget',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-050',
      'tests/behavioral/tm-auto-target.test.ts#TM8-051',
    ],
  },
  'DL-AUTO-TARGET': {
    home: 'src/lib/task-segments.ts',
    symbol: 'autoTargetAt',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-002',
      'tests/behavioral/tm-auto-target.test.ts#TM8-006',
      'tests/behavioral/tm-auto-target.test.ts#TM8-007',
    ],
  },
  'DL-CAP': {
    home: 'src/lib/task-segments.ts',
    symbol: 'capsAt',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-016',
      'tests/behavioral/tm-task-model.test.ts#TM-031',
      'tests/behavioral/rl-rule-pins.test.ts#RL-DL-CAP-BOUNDARY',
    ],
  },
  'DL-RELATIVE-WRITE-RULES': {
    home: 'src/lib/task-segments.ts',
    symbol: 'resolveRelative',
    pins: [
      'tests/behavioral/rt-relative-target.test.ts#RT23',
      'tests/behavioral/rt-relative-target.test.ts#RT25',
      'tests/behavioral/rt-relative-target.test.ts#RT29',
    ],
  },
  'TGT-RESOLVE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'resolveTarget',
    pins: ['tests/behavioral/tm-auto-target.test.ts#TM8-033'],
  },
  'TGT-DEADLINE-CHANGE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'resolveFixed',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-030',
      'tests/behavioral/tm-auto-target.test.ts#TM8-031',
      'tests/behavioral/tm-auto-target.test.ts#TM8-032',
    ],
  },
  'DL-NO-FAKE-TARGET': {
    home: 'src/lib/task-segments.ts',
    symbol: 'resolveFixed',
    pins: [
      'tests/behavioral/tm-no-fake-targets.test.ts#NF-G01',
      'tests/behavioral/tm-no-fake-targets.test.ts#NF-G02a',
      'tests/behavioral/tm-deadlines.test.ts#DL-W01',
    ],
  },
  'DL-DEADLINE-DAY-PICK': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deadlineDayTarget',
    pins: ['tests/behavioral/tm-auto-target.test.ts#TM8-015'],
  },
  'DL-HORIZON-PULL': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deadlineHorizon',
    pins: ['tests/behavioral/tm-task-model.test.ts#TM-002'],
  },
  'SEG-CHECKIN-DAY': {
    home: 'src/lib/task-segments.ts',
    symbol: 'CHECK_IN_DAY_DEFAULT',
    pins: [
      'tests/behavioral/up-upcoming.test.ts#UP-060',
      'tests/behavioral/tq-day-everywhere.test.ts#TQ-EV05',
    ],
  },
  'HZ-SEGMENT-CADENCE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'latestSegmentDay',
    pins: ['tests/behavioral/tm-task-model.test.ts#TM-001'],
  },
  'TGT-QUIET': {
    home: 'src/lib/task-segments.ts',
    symbol: 'hasPickedTarget(task)',
    pins: [
      'tests/behavioral/tm-task-model.test.ts#TM-012',
      'tests/behavioral/tm-auto-target.test.ts#TM8-051',
    ],
  },
  'SEG-CARRYOVER': {
    home: 'src/lib/task-segments.ts',
    symbol: 'last_considered_at',
    pins: ['tests/behavioral/tm-task-model.test.ts#TM-011'],
  },
  'AGE-THRESHOLDS': {
    home: 'src/lib/task-segments.ts',
    symbol: 'AGE_THRESHOLDS',
    pins: ['tests/behavioral/ag-aged-out.test.ts#AG-013'],
  },
  'HZ-UNSET': {
    home: 'src/lib/task-segments.ts',
    symbol: 'setHorizonOrUnset',
    pins: [
      'tests/behavioral/pc-process.test.ts#PC-002',
      'tests/behavioral/rl-rule-pins.test.ts#RL-HZ-UNSET',
    ],
  },
  'TGT-AGE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'ageLabel',
    pins: ['tests/behavioral/bg-badges.test.ts#BG-021'],
  },
  'TGT-ATTEMPTS': {
    home: 'src/lib/task-segments.ts',
    symbol: 'effectiveAttempts',
    pins: [
      'tests/behavioral/bg-badges.test.ts#BG-001',
      'tests/behavioral/bg-badges.test.ts#BG-002',
      'tests/behavioral/bg-badges.test.ts#BG-012',
    ],
  },
  'TGT-ATTEMPTS-LABEL': {
    home: 'src/lib/task-segments.ts',
    symbol: 'attemptsLabel',
    pins: ['tests/behavioral/bg-badges.test.ts#BG-006'],
  },
  'TGT-ATTEMPTS-OFFER': {
    home: 'src/lib/task-segments.ts',
    symbol: 'attemptsOffer',
    pins: [
      'tests/behavioral/bg-badges.test.ts#BG-007',
      'tests/behavioral/tq-rollover.test.ts#TQ-O01',
      'tests/behavioral/rl-rule-pins.test.ts#RL-TGT-ATTEMPTS-OFFER',
    ],
  },
  'TQ-ROLLOVER-WHO': {
    home: 'src/lib/task-segments.ts',
    symbol: 'queueStrippable',
    pins: [
      'tests/behavioral/tq-rollover.test.ts#TQ-R05',
      'tests/behavioral/rl-rule-pins-db.test.ts#RL-TQ-ROLLOVER-WHO',
    ],
  },
  'TQ-PANEL-KIND': {
    home: 'src/lib/task-segments.ts',
    symbol: 'queueKind',
    pins: [
      'tests/behavioral/tq-panels.test.ts#TQ-P04q',
      'tests/behavioral/tq-panels.test.ts#TQ-P11q',
      'tests/behavioral/rl-rule-pins.test.ts#RL-TQ-PANEL-PULLED',
    ],
  },
  'SEG-ROW-STATE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'queueRowState',
    pins: ['tests/behavioral/rl-rule-pins.test.ts#RL-SEG-ROW-STATE'],
  },
  'TQ-PANEL-ORDER': {
    home: 'src/lib/task-segments.ts',
    symbol: 'compareQueueRows',
    pins: ['tests/behavioral/tq-panels.test.ts#TQ-P10q'],
  },
  'DL-PASSED-MARKER': {
    home: 'src/lib/task-segments.ts',
    symbol: 'isPastDeadline',
    pins: [
      'tests/behavioral/tm-task-model.test.ts#TM-031',
      'tests/behavioral/rl-rule-pins.test.ts#RL-DL-CAP-BOUNDARY',
    ],
  },
  'TGT-OCCURRENCE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'occurrenceDates',
    pins: [
      'tests/behavioral/tm-occurrence.test.ts#TM6-002',
      'tests/behavioral/tm-occurrence.test.ts#TM6-010',
    ],
  },
  'DL-RELATIVE-DERIVE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'relativeTargetAt',
    pins: [
      'tests/behavioral/rt-relative-target.test.ts#RT01',
      'tests/behavioral/rt-relative-target.test.ts#RT-G01',
    ],
  },
  'TGT-TARGET-MOVED': {
    home: 'src/lib/task-segments.ts',
    symbol: 'targetMoved',
    pins: ['tests/behavioral/tm-repeat-anchor.test.ts#TM-RA05'],
  },
  'DL-SCHEDULE-BASE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'scheduleBase',
    pins: ['tests/behavioral/tm-repeat-anchor.test.ts#TM-RA45'],
  },
  'DL-RELATIVE-VALIDATION': {
    home: 'src/lib/task-segments.ts',
    symbol: 'relativeTargetProblem',
    pins: [
      'tests/behavioral/tm-repeat-anchor.test.ts#TM-RA10',
      'tests/behavioral/rt-relative-target.test.ts#RT12',
      'tests/behavioral/rt-relative-target.test.ts#RT24',
    ],
  },
  'DL-LEAD-TABLE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deadlineLeadDays',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-001b',
      'tests/behavioral/tm-deadlines.test.ts#DL-L01',
    ],
  },
  'DL-LEAD-OVERRIDE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'leadDaysProblem',
    pins: [
      'tests/behavioral/tm-deadlines.test.ts#DL-F05',
      'tests/behavioral/up-upcoming.test.ts#UP-113',
    ],
  },
  'DL-LEAD-DAY': {
    home: 'src/lib/task-segments.ts',
    symbol: 'leadFor',
    pins: [
      'tests/behavioral/tm-deadlines.test.ts#DL-L01',
      'tests/behavioral/tm-deadlines.test.ts#DL-L02',
    ],
  },
  'DL-PAGE-MEMBERSHIP': {
    home: 'src/lib/task-segments.ts',
    symbol: 'isDeadlinePageTask',
    pins: [
      'tests/behavioral/tm-deadlines.test.ts#DL-S01',
      'tests/behavioral/tm-deadlines.test.ts#DL-W04',
    ],
  },
  'DL-PLACE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deadlinePlace',
    pins: ['tests/behavioral/tm-deadlines.test.ts#DL-L03'],
  },
  'DL-UPCOMING-RULE3': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deadlinePlace',
    pins: ['tests/behavioral/tm-deadlines.test.ts#DL-L03'],
  },
  'DL-ORDER': {
    home: 'src/lib/task-segments.ts',
    symbol: 'compareDeadlineRows',
    pins: ['tests/behavioral/tm-deadlines.test.ts#DL-S02'],
  },
  'DL-DEFER-LEAD': {
    home: 'src/lib/task-segments.ts',
    symbol: 'leadDeferRefusal',
    pins: [
      'tests/behavioral/tm-deadlines.test.ts#DL-D01',
      'tests/behavioral/tm-deadlines.test.ts#DL-D02',
      'tests/behavioral/tm-deadlines.test.ts#DL-F06',
    ],
  },
  'UP-DAYS': {
    home: 'src/lib/task-segments.ts',
    symbol: 'upcomingDays',
    pins: [
      'tests/behavioral/up-upcoming.test.ts#UP-110',
      'tests/behavioral/up-upcoming.test.ts#UP-001',
    ],
  },
  'UP-MEMBERS': {
    home: 'src/lib/task-segments.ts',
    symbol: 'upcomingCandidate',
    pins: [
      'tests/behavioral/up-upcoming.test.ts#UP-100',
      'tests/behavioral/tm-auto-target.test.ts#TM8-050',
    ],
  },
  'UP-PLACEMENT': {
    home: 'src/lib/task-segments.ts',
    symbol: 'upcomingState',
    pins: [
      'tests/behavioral/up-upcoming.test.ts#UP-030',
      'tests/behavioral/up-upcoming.test.ts#UP-111',
    ],
  },
  'TGT-REMOVE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'targetReset',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-022',
      'tests/behavioral/up-upcoming.test.ts#UP-043',
      'tests/behavioral/tm-deadlines.test.ts#DL-W04',
    ],
  },
  'DECK-DAY': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deckDayProblem',
    pins: ['tests/behavioral/od-deck.test.ts#OD-R01', 'tests/behavioral/od-deck.test.ts#OD-W07'],
  },
  'DECK-TODAY': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deckIsToday',
    pins: [
      'tests/behavioral/tq-day-everywhere.test.ts#TQ-EV07',
      'tests/behavioral/rl-rule-pins.test.ts#RL-DECK-TODAY',
    ],
  },
  'DECK-ELIGIBLE': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deckSkip',
    pins: [
      'tests/behavioral/od-deck.test.ts#OD-W10',
      'tests/behavioral/od-repeating.test.ts#OD-RP01',
    ],
  },
  'DECK-A1': {
    home: 'src/lib/task-segments.ts',
    symbol: 'deckRefusal',
    pins: [
      'tests/behavioral/od-deck.test.ts#OD-R02',
      'tests/behavioral/od-repeating.test.ts#OD-RP53',
    ],
  },
  'TGT-ATTEMPTS-RESET': {
    home: 'src/core/tasks/target-set.ts',
    symbol: 'ATTEMPTS_RESET_SQL',
    pins: [
      'tests/behavioral/bg-badges.test.ts#BG-004',
      'tests/behavioral/bg-badges.test.ts#BG-005',
      'tests/behavioral/rl-rule-pins-db.test.ts#RL-TGT-ATTEMPTS-RESET',
    ],
  },
  'TGT-SET-AT': {
    home: 'src/core/tasks/target-set.ts',
    symbol: 'stampTargetSet',
    pins: [
      'tests/behavioral/up-upcoming.test.ts#UP-080',
      'tests/behavioral/up-upcoming.test.ts#UP-090',
    ],
  },
  'TGT-ATTEMPTS-CHECKPOINT': {
    home: 'src/core/tasks/target-set.ts',
    symbol: 'stampTargetSet',
    pins: [
      'tests/behavioral/bg-badges.test.ts#BG-003',
      'tests/behavioral/bg-badges.test.ts#BG-011',
    ],
  },
  'TQ-CLEAR-ON-TARGET': {
    home: 'src/core/tasks/target-set.ts',
    symbol: 'stampTargetSet',
    pins: [
      'tests/behavioral/tq-defers.test.ts#TQ-C11',
      'tests/behavioral/tq-summary.test.ts#TQ-G10',
    ],
  },
  'DECK-NEVER-NAGS': {
    home: 'src/core/recurrence/occurrence.ts',
    symbol: 'on_deck_day',
    pins: [
      'tests/behavioral/od-repeating.test.ts#OD-RP03',
      'tests/behavioral/rl-rule-pins.test.ts#RL-TGT-OVERDUE',
    ],
  },
  'TGT-OVERDUE': {
    home: 'src/core/recurrence/occurrence.ts',
    symbol: 'isCurrentlyDue',
    pins: [
      'tests/behavioral/oc-occurrence.test.ts#OC-001',
      'tests/behavioral/gt-get-tasks-filters.test.ts#GT-003',
      'tests/behavioral/rl-rule-pins.test.ts#RL-TGT-OVERDUE',
    ],
  },
  'TGT-OVERDUE-CLIENT': {
    home: 'src/lib/task-counts.ts',
    symbol: 'isOverdue',
    pins: ['tests/behavioral/rl-rule-pins.test.ts#RL-TGT-OVERDUE-CLIENT'],
  },
  'TGT-REMINDER-NO-SNOOZE': {
    home: 'src/core/tasks/helpers/collect-field-changes.ts',
    symbol: 'REMINDER_SNOOZE_MESSAGE',
    pins: [
      'tests/behavioral/sn-reschedule.test.ts#SN-120',
      'tests/behavioral/sn-reschedule.test.ts#SN-121',
      'tests/behavioral/rm-reminders.test.ts#RM-006',
    ],
  },
  'DL-CAP-REPORT': {
    home: 'src/core/tasks/helpers/collect-field-changes.ts',
    symbol: 'resolveTargetInput',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-010',
      'tests/behavioral/tm-task-model.test.ts#TM-060',
    ],
  },
  'DECK-REPEATING': {
    home: 'src/core/tasks/helpers/collect-field-changes.ts',
    symbol: 'collectRepeatingUndeck',
    pins: [
      'tests/behavioral/od-repeating.test.ts#OD-RP10',
      'tests/behavioral/od-repeating.test.ts#OD-RP15',
    ],
  },
  'HZ-CLOCK': {
    home: 'src/core/tasks/helpers/collect-field-changes.ts',
    symbol: 'horizon_set_at',
    pins: [
      'tests/behavioral/tm-task-model.test.ts#TM-051',
      'tests/behavioral/pc-process.test.ts#PC-010',
      'tests/behavioral/ag-aged-out.test.ts#AG-024',
    ],
  },
  'TGT-MOVE-ONE-GESTURE': {
    home: 'src/core/tasks/helpers/collect-field-changes.ts',
    symbol: 'collectDueAtChanges',
    pins: [
      'tests/behavioral/sn-reschedule.test.ts#SN-101',
      'tests/behavioral/sn-reschedule.test.ts#SN-103',
    ],
  },
  'TGT-ORIGIN': {
    home: 'src/core/tasks/helpers/collect-field-changes.ts',
    symbol: 'collectDueAtChanges',
    pins: [
      'tests/behavioral/sn-reschedule.test.ts#SN-103',
      'tests/behavioral/sn-reschedule.test.ts#SN-106',
    ],
  },
  'DL-LEGACY-FLAGS': {
    home: 'src/core/validation/task.ts',
    symbol: 'deadline_nag_off',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-011',
      'tests/behavioral/tm-task-model.test.ts#TM-039',
    ],
  },
  'TGT-FIELD': {
    home: 'src/core/validation/task.ts',
    symbol: 'normalizeTargetAliases',
    pins: ['tests/behavioral/tm-task-model.test.ts#TM-050'],
  },
  'DL-NATIVE-NAGOFF': {
    home: 'src/lib/format-task.ts',
    symbol: 'nativeNagOff',
    pins: ['tests/behavioral/tm-deadlines.test.ts#DL-S03'],
  },
  'DL-PASSED-HIGH': {
    home: 'src/core/tasks/bulk.ts',
    symbol: 'bulkSnoozeTier',
    pins: [
      'tests/behavioral/tm-auto-target.test.ts#TM8-040',
      'tests/behavioral/tm-auto-target.test.ts#TM8-042',
    ],
  },
  'BULK-SWEEP-CEILING': {
    home: 'src/core/tasks/bulk.ts',
    symbol: 'filterForBulkSnooze',
    pins: [
      'tests/behavioral/bo-bulk.test.ts#BH-001',
      'tests/behavioral/bo-bulk.test.ts#BH-002',
      'tests/behavioral/bo-bulk.test.ts#BH-003',
    ],
  },
  'TQ-ONE-HIGH': {
    home: 'src/core/tasks/bulk.ts',
    symbol: 'pickOneHigh',
    pins: [
      'tests/behavioral/tq-defers.test.ts#TQ-M02',
      'tests/behavioral/tq-defers.test.ts#TQ-H01',
    ],
  },
  'TQ-PICK-DEFER': {
    home: 'src/core/tasks/bulk.ts',
    symbol: 'deferContext',
    pins: [
      'tests/behavioral/tq-defers.test.ts#TQ-L15',
      'tests/behavioral/tq-defers.test.ts#TQ-C03',
    ],
  },
  'TQ-MARK-LANDING': {
    home: 'src/core/tasks/bulk.ts',
    symbol: 'planLanding',
    pins: [
      'tests/behavioral/tq-defers.test.ts#TQ-L02',
      'tests/behavioral/tq-defers.test.ts#TQ-T04',
      'tests/behavioral/tq-defers.test.ts#TQ-R01d',
    ],
  },
  'TQ-REMEMBER-TARGET': {
    home: 'src/core/tasks/bulk.ts',
    symbol: 'deferQueueFields',
    pins: [
      'tests/behavioral/tq-rollover.test.ts#TQ-S01b',
      'tests/behavioral/tq-rollover.test.ts#TQ-S01c',
    ],
  },
  'TQ-TRY-TOMORROW': {
    home: 'src/core/tasks/bulk.ts',
    symbol: 'try_tomorrow',
    pins: [
      'tests/behavioral/tq-defers.test.ts#TQ-T01',
      'tests/behavioral/tq-defers.test.ts#TQ-T05',
    ],
  },
  'TQ-SWITCH': {
    home: 'src/core/tasks/task-queue.ts',
    symbol: 'taskQueueEnabled',
    pins: [
      'tests/behavioral/tq-rollover.test.ts#TQ-R08',
      'tests/behavioral/tq-run-now.test.ts#TQ-N12',
    ],
  },
  'DAY-BOUNDARY-SWITCH': {
    home: 'src/core/tasks/rollover-time.ts',
    symbol: 'THE DAY BOUNDARY',
    pins: [
      'tests/behavioral/tq-day-guard.test.ts#TQ-G03',
      'tests/behavioral/browser-day-start.test.ts#BDS-03',
    ],
  },
  'TQ-ROLLOVER-ONCE': {
    home: 'src/core/tasks/task-rollover.ts',
    symbol: 'rolloverUser',
    pins: [
      'tests/behavioral/tq-rollover.test.ts#TQ-R01',
      'tests/behavioral/tq-rollover.test.ts#TQ-R04',
    ],
  },
  'TQ-STRIP-ONEOFF': {
    home: 'src/core/tasks/task-rollover.ts',
    symbol: 'function strip',
    pins: ['tests/behavioral/tq-rollover.test.ts#TQ-S01'],
  },
  'TQ-RELEASE': {
    home: 'src/core/tasks/task-rollover.ts',
    symbol: 'function release',
    pins: ['tests/behavioral/tq-rollover.test.ts#TQ-P05'],
  },
  'TQ-ROLL-WAIT': {
    home: 'src/core/tasks/task-rollover.ts',
    symbol: 'rollRepeating',
    pins: [
      'tests/behavioral/tq-rollover.test.ts#TQ-P01',
      'tests/behavioral/tq-rollover.test.ts#TQ-P04',
    ],
  },
  'DECK-ROLLOVER': {
    home: 'src/core/tasks/task-rollover.ts',
    symbol: 'stripDecks',
    pins: ['tests/behavioral/od-deck.test.ts#OD-RO01', 'tests/behavioral/od-deck.test.ts#OD-RO03'],
  },
  'TQ-FENCE': {
    home: 'src/core/undo/rollover-fence.ts',
    symbol: 'rolledOverSince',
    pins: [
      'tests/behavioral/tq-rollover.test.ts#TQ-R09',
      'tests/behavioral/tq-rollover.test.ts#TQ-R10',
    ],
  },
  'TQ-RUN-NOW': {
    home: 'src/core/tasks/rollover-now.ts',
    symbol: 'runRolloverNow',
    pins: [
      'tests/behavioral/tq-run-now.test.ts#TQ-N01',
      'tests/behavioral/tq-run-now.test.ts#TQ-N03',
    ],
  },
  'SEG-NEVER-NOTIFIED': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'SEPARATE FROM THE TIME SLOTS',
    pins: [
      'tests/behavioral/od-deck.test.ts#OD-P02',
      'tests/behavioral/rl-rule-pins-db.test.ts#RL-SEG-NEVER-NOTIFIED',
    ],
  },
  'SEG-ELIGIBLE': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'eligibleTasks',
    pins: ['tests/behavioral/tm-task-model.test.ts#TM-013'],
  },
  'TQ-OPT-IN': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'queuePanels',
    pins: [
      'tests/behavioral/tq-panels.test.ts#TQ-P14q',
      'tests/behavioral/tm-deadlines.test.ts#DL-S01',
      'tests/behavioral/od-repeating.test.ts#OD-RP30',
    ],
  },
  'TQ-PRECEDENCE': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'placeFirst',
    pins: [
      'tests/behavioral/tq-panels.test.ts#TQ-P02q',
      'tests/behavioral/tq-panels.test.ts#TQ-P03q',
    ],
  },
  'SEG-FILL': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'fill',
    pins: [
      'tests/behavioral/tm-fill-segments.test.ts#TM-FILL04',
      'tests/behavioral/tm-fill-segments.test.ts#TM-FILL05',
    ],
  },
  'SEG-ORDER-WITHIN': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'b.task.priority - a.task.priority',
    pins: ['tests/behavioral/tm-task-model.test.ts#TM-014'],
  },
  'UP-ORDER': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'sectionRank',
    pins: ['tests/behavioral/up-upcoming.test.ts#UP-112'],
  },
  'SEG-ACTIONS': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'stampTasks',
    pins: [
      'tests/behavioral/tm-task-model.test.ts#TM-016',
      'tests/behavioral/tm-task-model.test.ts#TM-019',
      'tests/behavioral/tq-panels.test.ts#TQ-P05q',
    ],
  },
  'SEG-NOT-TODAY': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'deferTasks',
    pins: [
      'tests/behavioral/tm-task-model.test.ts#TM-015',
      'tests/behavioral/rl-rule-pins.test.ts#RL-SEG-NOT-TODAY',
    ],
  },
  'SEG-TARGET-TODAY': {
    home: 'src/core/tasks/task-segments.ts',
    symbol: 'targetTasksToday',
    pins: [
      'tests/behavioral/tm-task-model.test.ts#TM-020',
      'tests/behavioral/tm-task-model.test.ts#TM-021',
      'tests/behavioral/up-upcoming.test.ts#UP-070',
    ],
  },
  'SEG-ROSTER': {
    home: 'src/core/tasks/segment-roster.ts',
    symbol: 'rosterLeftRows',
    pins: [
      'tests/behavioral/tq-day-roster.test.ts#TQ-R01r',
      'tests/behavioral/tq-day-roster.test.ts#TQ-R07r',
    ],
  },
  'DECK-EXCLUSIVE': {
    home: 'src/core/tasks/deck-clear.ts',
    symbol: 'deckClearedBy',
    pins: [
      'tests/behavioral/od-deck.test.ts#OD-W03',
      'tests/behavioral/od-repeating.test.ts#OD-RP13',
    ],
  },
  'DECK-A7-STAMPS': {
    home: 'src/core/tasks/deck-clear.ts',
    symbol: 'deckKeepsPageRow',
    pins: [
      'tests/behavioral/tm-deadlines.test.ts#DL-S06',
      'tests/behavioral/tm-deadlines.test.ts#DL-S07',
    ],
  },
  'DL-RELATIVE-LINK': {
    home: 'src/core/tasks/relative-target.ts',
    symbol: 'linkTargetTime',
    pins: [
      'tests/behavioral/rt-relative-target.test.ts#RT28',
      'tests/behavioral/rt-relative-target.test.ts#RT-G04',
    ],
  },
  'DL-STOP-REPEATING-KEEPS': {
    home: 'src/core/tasks/relative-target.ts',
    symbol: 'stopKeepsRelative',
    pins: [
      'tests/behavioral/rt-relative-target.test.ts#RT70',
      'tests/behavioral/rt-relative-target.test.ts#RT72',
    ],
  },
  'DL-REPEAT-ANCHOR': {
    home: 'src/core/tasks/repeat-schedule.ts',
    symbol: 'createAnchor',
    pins: [
      'tests/behavioral/tm-repeat-anchor.test.ts#TM-RA30',
      'tests/behavioral/tm-repeat-anchor.test.ts#TM-RA35',
    ],
  },
  'DL-REPEAT-NO-DEFAULT': {
    home: 'src/core/tasks/repeat-schedule.ts',
    symbol: 'resolveRelativeTarget',
    pins: [
      'tests/behavioral/tm-deadlines.test.ts#DL-W02',
      'tests/behavioral/tm-deadlines.test.ts#DL-F10',
    ],
  },
  'DL-ENRICH': {
    home: 'src/core/ai/enrichment.ts',
    symbol: 'withoutRuleOnDeadline',
    pins: ['tests/behavioral/rl-rule-pins.test.ts#RL-DL-ENRICH'],
  },
  'TQ-NOW-QUEUED': {
    home: 'src/lib/now-view.ts',
    symbol: 'isRelevantNow',
    pins: [
      'tests/behavioral/od-deck.test.ts#OD-R06',
      'tests/behavioral/tm-deadlines.test.ts#DL-S04',
    ],
  },
  'AG-GROW-STEP': {
    home: 'src/lib/aged-out.ts',
    symbol: 'growStep',
    pins: [
      'tests/behavioral/ag-aged-out.test.ts#AG-001',
      'tests/behavioral/ag-aged-out.test.ts#AG-022',
      'tests/behavioral/ag-aged-out.test.ts#AG-025',
    ],
  },
  'AG-MEMBERS': {
    home: 'src/lib/aged-out.ts',
    symbol: 'agedOutState',
    pins: [
      'tests/behavioral/ag-aged-out.test.ts#AG-010',
      'tests/behavioral/ag-aged-out.test.ts#AG-011',
      'tests/behavioral/ag-aged-out.test.ts#AG-014',
    ],
  },
  'AG-GROUPS': {
    home: 'src/lib/aged-out.ts',
    symbol: 'compareAgedOut',
    pins: ['tests/behavioral/ag-aged-out.test.ts#AG-050'],
  },
  'GROW-ASK': {
    home: 'src/lib/process-rules.ts',
    symbol: 'growthAsk',
    pins: [
      'tests/behavioral/pc-process.test.ts#PC-008',
      'tests/behavioral/pc-process.test.ts#PC-009',
      'tests/behavioral/ag-aged-out.test.ts#AG-014',
    ],
  },
  'UP-SECTIONS-WEB': {
    home: 'src/lib/upcoming-sections.ts',
    symbol: 'upcomingSections',
    pins: ['tests/behavioral/up-sections.test.ts#UP-120'],
  },
  'TGT-DAY-FIRST': {
    home: 'src/lib/target-day-first.ts',
    symbol: 'nextTargetDayFirst',
    pins: [
      'tests/behavioral/tm-target-day-first.test.ts#nextTargetDayFirst',
      'tests/behavioral/rl-rule-pins.test.ts#RL-TGT-DAY-FIRST',
    ],
  },
  'SEG-VISIBLE-WEB': {
    home: 'src/hooks/useTaskSegments.ts',
    symbol: 'listedSegments',
    pins: ['tests/behavioral/rl-rule-pins.test.ts#RL-SEG-VISIBLE-WEB'],
  },
  'SEG-PULLED-MERGE': {
    home: 'src/hooks/useTaskSegments.ts',
    symbol: 'mergePulled',
    pins: [
      'tests/behavioral/pulled-merge.test.ts#mergePulled',
      'tests/behavioral/rl-rule-pins.test.ts#RL-SEG-PULLED-MERGE',
    ],
  },
  'DAY-GUARD': {
    home: 'src/lib/opentask-day.ts',
    symbol: 'tq-day-guard.test.ts',
    pins: [
      'tests/behavioral/tq-day-guard.test.ts#TQ-G01',
      'tests/behavioral/tq-day-guard.test.ts#TQ-G03b',
    ],
  },
  'LOCAL-MOMENT-DST': {
    home: 'src/lib/opentask-day.ts',
    symbol: 'localMoment',
    pins: ['tests/behavioral/rl-rule-pins.test.ts#RL-LOCAL-MOMENT-DST'],
  },
  'DAY-NAMING': {
    home: 'src/lib/opentask-day.ts',
    symbol: 'openTaskDayOf',
    pins: ['tests/behavioral/tq-day-directions.test.ts#TQ-DD03'],
  },
  'PERIOD-OPENS-AT': {
    home: 'src/lib/opentask-day.ts',
    symbol: 'periodOpensAt',
    pins: ['tests/behavioral/tq-day-directions.test.ts#TQ-DD20'],
  },
  'TQ-EARLY-PICK': {
    home: 'src/lib/opentask-day.ts',
    symbol: 'isEarlyMorningPick',
    pins: [
      'tests/behavioral/tq-rollover.test.ts#TQ-S06',
      'tests/behavioral/tq-rollover.test.ts#TQ-S06b',
      'tests/behavioral/tq-rollover.test.ts#TQ-S08',
    ],
  },
  'DAY-START-DEFAULT': {
    home: 'src/lib/anchor-times.ts',
    symbol: 'resolveDayStart',
    pins: ['tests/behavioral/ts-day-start.test.ts#TDS-001'],
  },
  'BROWSER-DAY-UNKNOWN': {
    home: 'src/lib/browser-day-start.ts',
    symbol: 'browserDayStart',
    pins: [
      'tests/behavioral/browser-day-start.test.ts#BDS-03',
      'tests/behavioral/browser-day-start.test.ts#BDS-04',
    ],
  },
  'PRIO-THRESHOLDS': {
    home: 'src/lib/priority.ts',
    symbol: 'HIGH_PRIORITY_THRESHOLD',
    pins: [
      'tests/behavioral/bo-bulk.test.ts#BH-002',
      'tests/behavioral/rl-rule-pins.test.ts#RL-PRIO-THRESHOLDS',
    ],
  },
  'NAG-TIER-DEFAULTS': {
    home: 'src/core/db/schema.sql',
    symbol: 'auto_snooze_minutes',
    pins: [
      'tests/behavioral/cl-cadence-ladder.test.ts#CL-001',
      'tests/behavioral/cl-cadence-ladder.test.ts#CL-002',
      'tests/behavioral/cl-cadence-ladder.test.ts#CL-003',
      'tests/behavioral/cl-cadence-ladder.test.ts#CL-004',
      'tests/behavioral/cl-cadence-ladder.test.ts#CL-005',
    ],
  },
  'NO-QUIET-HOURS': {
    home: 'src/core/notifications/nag-ladder.ts',
    symbol: 'THE NAG LADDER',
    pins: [
      'tests/behavioral/dn-deadline-nags.test.ts#DN-003',
      'tests/behavioral/rm-slot-nags.test.ts#RN-001',
    ],
  },
  'NAG-LADDER': {
    home: 'src/core/notifications/nag-ladder.ts',
    symbol: 'NAG_LADDER',
    pins: ['tests/behavioral/dn-deadline-nags.test.ts#DN-001'],
  },
  'NAG-SAFETY-NET': {
    home: 'src/core/notifications/nag-ladder.ts',
    symbol: 'SAFETY_NET_FLOOR_MINUTES',
    pins: ['tests/behavioral/dn-deadline-nags.test.ts#DN-002'],
  },
  'NAG-PER-TASK-OVERRIDE': {
    home: 'src/core/notifications/overdue-checker.ts',
    symbol: 'getEffectiveInterval',
    pins: [
      'tests/behavioral/cl-cadence-ladder.test.ts#CL-007',
      'tests/behavioral/cl-cadence-ladder.test.ts#CL-008',
      'tests/behavioral/rm-reminder-nags.test.ts#RR-01',
    ],
  },
  'OVERDUE-FIRST-PUSH': {
    home: 'src/core/notifications/overdue-checker.ts',
    symbol: 'isNotificationBoundary',
    pins: [
      'tests/behavioral/notification-timing.test.ts#isNotificationBoundary',
      'tests/behavioral/cl-cadence-ladder.test.ts#CL-001',
    ],
  },
  'OVERDUE-CONSOLIDATION': {
    home: 'src/core/notifications/overdue-checker.ts',
    symbol: 'splitIntoBuckets',
    pins: ['tests/behavioral/notification-timing.test.ts#consolidation caps'],
  },
  'BADGE-ON-CHANGE': {
    home: 'src/core/notifications/overdue-checker.ts',
    symbol: 'sendChangedBadges',
    pins: [
      'tests/behavioral/badge-push.test.ts#the overdue checker sends a badge only when the count changes',
    ],
  },
  'MARKS-GRID': {
    home: 'src/core/notifications/nag-marks.ts',
    symbol: 'nextNagAt',
    pins: [
      'tests/behavioral/dn-nag-marks.test.ts#DN-M02',
      'tests/behavioral/dn-nag-marks.test.ts#DN-M03',
    ],
  },
  'NAG-SENDS-PACING': {
    home: 'src/core/notifications/nag-sends.ts',
    symbol: 'claimNagSend',
    pins: ['tests/behavioral/dn-deadline-nags.test.ts#DN-004'],
  },
  'TICK-MINUTE-CLAIM': {
    home: 'src/core/notifications/nag-sends.ts',
    symbol: 'claimTickMinute',
    pins: ['tests/behavioral/dn-tick.test.ts#DN-T09'],
  },
  'TICK-SOURCE-ORDER': {
    home: 'src/core/notifications/minute-tick.ts',
    symbol: 'MINUTE_TICK_SOURCES',
    pins: [
      'tests/behavioral/dn-tick.test.ts#DN-T05',
      'tests/behavioral/rm-slot-nags.test.ts#RN-006',
    ],
  },
  'TICK-LEAD-ORDER': {
    home: 'src/core/notifications/tick.ts',
    symbol: 'LEAD_ORDER',
    pins: [
      'tests/behavioral/dn-tick.test.ts#DN-T01',
      'tests/behavioral/dn-tick.test.ts#DN-T06',
      'tests/behavioral/dn-tick.test.ts#DN-T08',
    ],
  },
  'SOUND-ONLY-ON-OVERDUE': {
    home: 'src/core/notifications/tick.ts',
    symbol: 'LEAD_ORDER',
    pins: [
      'tests/behavioral/rm-slot-nags.test.ts#RN-013b',
      'tests/behavioral/dn-tick.test.ts#DN-T06',
      'tests/behavioral/rm-reminder-nags.test.ts#RR-06',
    ],
  },
  'INTERRUPTION-LEVEL': {
    home: 'src/core/notifications/format.ts',
    symbol: 'interruptionLevelFor',
    pins: [
      'tests/behavioral/dn-tick.test.ts#DN-T04',
      'tests/behavioral/rl-rule-pins.test.ts#RL-INTERRUPTION-LEVEL',
    ],
  },
  'NOTIFIABLE-USERS': {
    home: 'src/core/notifications/notifiable-users.ts',
    symbol: 'notifiableUsers',
    pins: [
      'tests/behavioral/dn-deadline-nags.test.ts#DN-006',
      'tests/behavioral/rm-slot-nags.test.ts#RN-018',
      'tests/behavioral/rm-slot-nags.test.ts#RN-019',
    ],
  },
  'SLOT-NAG': {
    home: 'src/core/notifications/slot-nags.ts',
    symbol: 'pendingSlotNags',
    pins: [
      'tests/behavioral/rm-slot-nags.test.ts#RN-001',
      'tests/behavioral/rm-slot-nags.test.ts#RN-010',
    ],
  },
  'NAMED-PUSH-THRESHOLD': {
    home: 'src/core/notifications/reminder-nag-rule.ts',
    symbol: 'NAMED_REMINDER_MIN_PRIORITY',
    pins: [
      'tests/behavioral/rm-reminder-nags.test.ts#RR-01',
      'tests/behavioral/rm-reminder-nags.test.ts#RR-04',
    ],
  },
  'NAMED-PUSH-TIMING': {
    home: 'src/core/notifications/reminder-nags.ts',
    symbol: 'openedPeriods',
    pins: [
      'tests/behavioral/rm-reminder-nags.test.ts#RR-02',
      'tests/behavioral/rm-reminder-nags.test.ts#RR-03',
    ],
  },
  'DL-NAG': {
    home: 'src/core/notifications/deadline-nags.ts',
    symbol: 'countedDeadlineRows',
    pins: [
      'tests/behavioral/dn-deadline-nags.test.ts#DN-002',
      'tests/behavioral/dn-deadline-nags.test.ts#DN-003',
    ],
  },
  'DEADLINE-NAG-WORDS': {
    home: 'src/core/notifications/deadline-nags.ts',
    symbol: 'deadlineNagContent',
    pins: ['tests/behavioral/dn-deadline-nags.test.ts#DN-005'],
  },
  'DEADLINE-NAG-SWITCH': {
    home: 'src/core/notifications/deadline-nags.ts',
    symbol: 'pendingDeadlineNags',
    pins: ['tests/behavioral/dn-deadline-nags.test.ts#DN-003'],
  },
} as const satisfies Record<string, RuleEntry>

export type RuleId = keyof typeof RULE_REGISTRY
