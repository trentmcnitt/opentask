/**
 * Quota enrichment scenarios (2026-10-24)
 *
 * A quota is a count per period ("eggs twice a week" = 2 per week). The caller
 * declares the kind (`is_tracked: true` on POST /api/tasks); enrichment reads
 * the count, the period and the reminder period out of the words, through the
 * quota user prompt and `postProcessQuotaEnrichment`.
 *
 * The failure these guard against is TASK PRIMING: the shared system prompt
 * teaches "twice a week → FREQ=WEEKLY;BYDAY=TU,TH", and a quota has no days.
 * The units rule (Trent, 10-22): a quota counts TIMES — a measured amount of
 * one doing ("100 pushups", "20 min") stays in the title, target 1 per period.
 *
 * Output is the post-processed PLAN in stored shapes — `rrule` is the bare
 * period rule (`FREQ=WEEKLY;INTERVAL=2`) or null (keep the provisional one),
 * `progress_target` the count, `prompt_slot_label` the reminder period chosen
 * (null = the user's default), `prompt_enabled` false for "don't remind me".
 */

import type { AITestScenario } from '../types'

/** The shipped default periods (DEFAULT_TIME_SLOTS). */
const SLOTS = [
  { label: 'Early morning', start_time: '07:00' },
  { label: 'Morning', start_time: '09:00' },
  { label: 'Midday', start_time: '12:00' },
  { label: 'Afternoon', start_time: '16:00' },
  { label: 'Evening', start_time: '20:30' },
]

const TZ = 'America/Chicago'

export const enrichmentQuotaScenarios: AITestScenario[] = [
  {
    id: 'quota-eggs-twice-week',
    feature: 'enrichment_quota',
    description: 'The motivating case: "twice a week" is a count, not two weekdays',
    input: { text: 'eggs twice a week', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: {
        title: 'Eggs',
        progress_target: 2,
        rrule: 'FREQ=WEEKLY',
        prompt_slot_label: null,
        prompt_enabled: null,
        labels: [],
      },
      quality_notes:
        'Title is the bare noun "Eggs" — no invented verb ("Eat eggs" is an edit). ' +
        'Target 2 per week. The model must NOT answer like a task (rrule with BYDAY=TU,TH); ' +
        'model_answer.rrule should be null. No reminder time was said, so no prompt period.',
    },
  },
  {
    id: 'quota-swim-lunch',
    feature: 'enrichment_quota',
    description: 'A count per week plus a reminder time word that maps to a period',
    input: { text: 'swim 3x a week, remind me at lunch', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: {
        title: 'Swim',
        progress_target: 3,
        rrule: 'FREQ=WEEKLY',
        prompt_slot_label: 'Midday',
      },
      quality_notes:
        '"lunch" is the period noon falls in — Midday. The reminder words leave the title. ' +
        'prompt_enabled true or null are both acceptable (an explicit "remind me").',
    },
  },
  {
    id: 'quota-read-minutes',
    feature: 'enrichment_quota',
    description: 'Units: a measured amount stays in the title, the target counts times',
    input: { text: 'read 20 min every day', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { progress_target: 1, rrule: 'FREQ=DAILY' },
      must_not_include: { progress_target: 20 },
      quality_notes:
        'Title keeps the amount: "Read 20 min" (or "Read 20 minutes"). The target is 1 per day, ' +
        'never 20 — a quota counts times, not minutes.',
    },
  },
  {
    id: 'quota-pushups-reps',
    feature: 'enrichment_quota',
    description: 'Units (Trent, 10-22): "100 pushups a day" is one doing a day',
    input: { text: '100 pushups a day', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { title: '100 pushups', progress_target: 1, rrule: 'FREQ=DAILY' },
      must_not_include: { progress_target: 100 },
      quality_notes:
        'The approved units rule: title "100 pushups", target 1 per day. A target of 100 is wrong.',
    },
  },
  {
    id: 'quota-water-glasses',
    feature: 'enrichment_quota',
    description: 'Units: separate occasions through the day are the target',
    input: { text: 'drink 8 glasses of water a day', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { progress_target: 8, rrule: 'FREQ=DAILY' },
      quality_notes:
        'Eight separate drinks across the day are the count: target 8 per day. Title "Drink water" ' +
        '(or close to it, e.g. "Drink a glass of water"); "8 glasses" should not remain in the title.',
    },
  },
  {
    id: 'quota-every-other-day',
    feature: 'enrichment_quota',
    description: '"Every other day" is a day period with interval 2',
    input: { text: 'stretch every other day', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { title: 'Stretch', progress_target: 1, rrule: 'FREQ=DAILY;INTERVAL=2' },
    },
  },
  {
    id: 'quota-fortnight',
    feature: 'enrichment_quota',
    description: '"Once a fortnight" is a two-week period',
    input: { text: 'call grandma once a fortnight', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { progress_target: 1, rrule: 'FREQ=WEEKLY;INTERVAL=2' },
      quality_notes: 'Title "Call grandma" — the schedule words leave it.',
    },
  },
  {
    id: 'quota-quarterly',
    feature: 'enrichment_quota',
    description: 'A quarter is a three-month period',
    input: { text: 'date night 3 times a quarter', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: {
        title: 'Date night',
        progress_target: 3,
        rrule: 'FREQ=MONTHLY;INTERVAL=3',
      },
    },
  },
  {
    id: 'quota-yearly',
    feature: 'enrichment_quota',
    description: 'A yearly count',
    input: { text: 'donate blood 4 times a year', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { title: 'Donate blood', progress_target: 4, rrule: 'FREQ=YEARLY' },
    },
  },
  {
    id: 'quota-evening-word',
    feature: 'enrichment_quota',
    description: '"In the evening" is the user\'s Evening period (20:30), not a generic 7pm',
    input: { text: 'journal 5x a week in the evening', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: {
        title: 'Journal',
        progress_target: 5,
        rrule: 'FREQ=WEEKLY',
        prompt_slot_label: 'Evening',
      },
    },
  },
  {
    id: 'quota-no-remind',
    feature: 'enrichment_quota',
    description: '"Don\'t remind me" turns the daily prompt off',
    input: { text: "floss daily, don't remind me", timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: {
        title: 'Floss',
        progress_target: 1,
        rrule: 'FREQ=DAILY',
        prompt_enabled: false,
        prompt_slot_label: null,
      },
    },
  },
  {
    id: 'quota-no-period',
    feature: 'enrichment_quota',
    description: 'No period named: the provisional period is kept (rrule null)',
    input: { text: 'piano scales', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { title: 'Piano scales', rrule: null, prompt_slot_label: null },
      quality_notes:
        'Nothing names a count or a period, so the plan leaves the period alone (rrule null) and ' +
        'the target at 1 (or null). The bare noun phrase stays as typed.',
    },
  },
  {
    id: 'quota-label-explicit',
    feature: 'enrichment_quota',
    description: 'An explicit label request lands (at most one)',
    input: { text: 'run 3 times a week, label it fitness', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: {
        title: 'Run',
        progress_target: 3,
        rrule: 'FREQ=WEEKLY',
        labels: ['fitness'],
      },
    },
  },
  {
    id: 'quota-label-inferred-neg',
    feature: 'enrichment_quota',
    description: 'No label inferred from the subject; the rest of the words stay',
    input: { text: 'vitamins for the kids every day', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { progress_target: 1, rrule: 'FREQ=DAILY', labels: [] },
      must_not_include: { labels: ['kids', 'health'] },
      quality_notes:
        'Title keeps "for the kids" ("Vitamins for the kids"); no invented verb. No label: the ' +
        'user did not ask for one.',
    },
  },
  {
    id: 'quota-dictation',
    feature: 'enrichment_quota',
    description: 'Garbled dictation with filler words',
    input: {
      text: 'um so like I wanna do pushups uh four times every week or so',
      timezone: TZ,
      slots: SLOTS,
    },
    requirements: {
      must_include: { progress_target: 4, rrule: 'FREQ=WEEKLY' },
      quality_notes:
        'Title "Pushups" or "Do pushups" — fillers and "I wanna" removed, no other edits. 4 per week.',
    },
  },
  {
    id: 'quota-interval-cap-neg',
    feature: 'enrichment_quota',
    description: 'An interval past the cap (45 days > 30) is dropped, not clamped',
    input: { text: 'sauna every 45 days', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { title: 'Sauna', rrule: null },
      quality_notes:
        'The model should write day / interval 45 (what was said); the post-process drops it ' +
        'because a daily quota spans at most 30 days, so rrule is null and the provisional period ' +
        'stays. A model that writes a different period (e.g. month / interval 1 or 2) to fit the ' +
        'cap has changed what the user said — judge it down.',
    },
  },
  {
    id: 'quota-weekday-names',
    feature: 'enrichment_quota',
    description: 'Named weekdays become a weekly count; the days stay in notes',
    input: { text: 'gym Monday Wednesday Friday', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: { progress_target: 3, rrule: 'FREQ=WEEKLY' },
      quality_notes:
        'A quota has no days: 3 per week. The day names must not be lost — they belong in notes ' +
        '("Mon, Wed, Fri" or similar). Title "Gym".',
    },
  },
  {
    id: 'quota-couple-month',
    feature: 'enrichment_quota',
    description: '"A couple times a month" is 2 per month, with the count words at the front',
    input: {
      text: 'a couple times a month take the dog to the park',
      timezone: TZ,
      slots: SLOTS,
    },
    requirements: {
      must_include: { progress_target: 2, rrule: 'FREQ=MONTHLY' },
      quality_notes: 'Title "Take the dog to the park". 2 per month (not BYMONTHDAY days).',
    },
  },
  {
    id: 'quota-clock-time',
    feature: 'enrichment_quota',
    description: 'A clock time for the reminder snaps to the nearest period',
    input: { text: 'meditate twice a day, remind me at 7am', timezone: TZ, slots: SLOTS },
    requirements: {
      must_include: {
        title: 'Meditate',
        progress_target: 2,
        rrule: 'FREQ=DAILY',
        prompt_slot_label: 'Early morning',
      },
      quality_notes: '7am is the start of the Early morning period (07:00).',
    },
  },
  {
    id: 'quota-user-context-name',
    feature: 'enrichment_quota',
    description: 'A relationship resolves to a name from user context',
    input: {
      text: 'call my sister once a week',
      timezone: TZ,
      slots: SLOTS,
      userContext: 'My sister is Dana.',
    },
    requirements: {
      must_include: { title: 'Call Dana', progress_target: 1, rrule: 'FREQ=WEEKLY' },
    },
  },
]
