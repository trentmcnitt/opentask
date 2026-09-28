/**
 * Project assignment scenarios — explicit instruction and name match
 *
 * Since 2026-09-28 (Trent) a project is set in two cases: the user says where
 * to put the task ("add it to Work"), or the task text contains a project's
 * full name as a phrase, used as that name ("test task for job search" → Job
 * Search). There is still no inference from topic.
 *
 * The name-match guard these scenarios pin down:
 * - whole words only ("homework" / "workout" do not match Work)
 * - not a verb ("work out at the gym")
 * - not a schedule cue or a direction ("after work", "on the way home") —
 *   "after work" already resolves to a TIME in this prompt, and letting it
 *   also pick the Work project would file every errand run after work there
 * - never Inbox
 * - two matching names → the longer, more specific one; unrelated matches with
 *   no explicit instruction → null
 */

import type { AITestScenario } from '../types'

const PROJECTS_JOB = [
  { id: 1, name: 'Inbox', shared: false },
  { id: 2, name: 'Work', shared: false },
  { id: 3, name: 'Home', shared: false },
  { id: 4, name: 'Job Search', shared: false },
]

export const enrichmentProjectScenarios: AITestScenario[] = [
  {
    id: 'enrich-project-name-match',
    feature: 'enrichment',
    description: 'Name match: "test task for job search" with a Job Search project',
    input: {
      text: 'Test task for job search',
      timezone: 'America/Chicago',
      projects: PROJECTS_JOB,
    },
    requirements: {
      must_include: {
        project_name: 'Job Search',
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be "Job Search" — the text contains the project\'s full name ("job search") used as a noun naming what the task is for. ' +
        'Title should keep the user\'s words ("Test task for job search") — a name match is not an instruction to strip. ' +
        'No date, priority 0, labels empty.',
    },
  },
  {
    id: 'enrich-project-name-match-for-work',
    feature: 'enrichment',
    description: 'Name match on a one-word project: "print the expense report for work"',
    input: {
      text: 'print the expense report for work',
      timezone: 'America/Chicago',
      projects: PROJECTS_JOB,
    },
    requirements: {
      must_include: {
        project_name: 'Work',
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be "Work" — "for work" uses the project name as a noun naming the area the task belongs to. ' +
        'Title should be "Print the expense report for work" or close to it. ' +
        'No date, priority 0, labels empty.',
    },
  },
  {
    id: 'enrich-project-explicit-still-works',
    feature: 'enrichment',
    description: 'Explicit assignment still works: "update my resume, put it in job search"',
    input: {
      text: 'update my resume put it in job search',
      timezone: 'America/Chicago',
      projects: PROJECTS_JOB,
    },
    requirements: {
      must_include: {
        project_name: 'Job Search',
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be "Job Search" — explicit assignment. ' +
        'Title should be "Update my resume" — the instruction "put it in job search" is removed from the title. ' +
        'Labels must be empty (a project instruction is not a label request).',
    },
  },
  {
    id: 'enrich-project-topic-no-match',
    feature: 'enrichment',
    description: 'Topic only, no name: "apply to Acme" must not go to Job Search',
    input: {
      text: 'apply to Acme by Friday',
      timezone: 'America/Chicago',
      projects: PROJECTS_JOB,
    },
    requirements: {
      must_include: {
        project_name: null,
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be null — applying to a company is job-search TOPIC, but the text does not contain the name "job search". ' +
        'Inference from topic is forbidden. ' +
        'due_at should be the coming Friday at the default task time. Title like "Apply to Acme".',
    },
  },
  {
    id: 'enrich-project-generic-name-verb',
    feature: 'enrichment',
    description: 'Generic name used as a verb: "work out at the gym" with a Work project',
    input: {
      text: 'work out at the gym tomorrow',
      timezone: 'America/Chicago',
      projects: PROJECTS_JOB,
    },
    requirements: {
      must_include: {
        project_name: null,
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be null — "work out" is a verb phrase (exercise), not the name of the Work project. ' +
        'Title like "Work out at the gym". due_at tomorrow at the default task time.',
    },
  },
  {
    id: 'enrich-project-generic-name-substring',
    feature: 'enrichment',
    description: 'Project name inside a longer word: "homework" with Home and Work projects',
    input: {
      text: "check the kids' homework",
      timezone: 'America/Chicago',
      projects: PROJECTS_JOB,
    },
    requirements: {
      must_include: {
        project_name: null,
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be null — "homework" is one word; it contains neither "Home" nor "Work" as a word. ' +
        'Title like "Check the kids\' homework". No date, priority 0.',
    },
  },
  {
    id: 'enrich-project-schedule-cue',
    feature: 'enrichment',
    description: 'Schedule cue is not a project reference: "call the plumber after work"',
    input: {
      text: 'call the plumber after work',
      timezone: 'America/Chicago',
      projects: PROJECTS_JOB,
      userContext: 'I usually work M-F 8am-4pm.',
    },
    requirements: {
      must_include: {
        project_name: null,
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be null — "after work" is a schedule cue that resolves to a time, not a reference to the Work project. ' +
        'due_at should be around 4:00 PM local (end of the work day per context, no Z suffix). ' +
        'Title like "Call the plumber".',
    },
  },
  {
    id: 'enrich-project-two-match-longer-wins',
    feature: 'enrichment',
    description: 'Two names match, one contains the other: "work travel" with Work and Work Travel',
    input: {
      text: 'book the hotel for work travel next month',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Work', shared: false },
        { id: 3, name: 'Work Travel', shared: false },
      ],
    },
    requirements: {
      must_include: {
        project_name: 'Work Travel',
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be "Work Travel" — both "Work" and "Work Travel" appear, and the longer, more specific name wins. ' +
        'Title like "Book the hotel for work travel". A date next month is acceptable (or null if the model treats it as vague).',
    },
  },
  {
    id: 'enrich-project-two-match-ambiguous',
    feature: 'enrichment',
    description: 'Two unrelated names match with no instruction: "home" and "work" → null',
    input: {
      text: 'plan the monthly budget for home and work',
      timezone: 'America/Chicago',
      projects: PROJECTS_JOB,
    },
    requirements: {
      must_include: {
        project_name: null,
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be null — "home" and "work" are both project names, neither contains the other, and the user gave no explicit instruction, so the match is ambiguous. ' +
        'Title like "Plan the monthly budget for home and work".',
    },
  },
  {
    id: 'enrich-project-inbox-never-matched',
    feature: 'enrichment',
    description: 'Inbox is never a name-match target: "clean out my email inbox"',
    input: {
      text: 'clean out my email inbox',
      timezone: 'America/Chicago',
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Work', shared: false },
      ],
    },
    requirements: {
      must_include: {
        project_name: null,
        labels: [],
        rrule: null,
      },
      quality_notes:
        'project_name MUST be null — Inbox is the default project and never a name-match target; "email inbox" is the subject of the task. ' +
        'Title like "Clean out my email inbox".',
    },
  },
]
