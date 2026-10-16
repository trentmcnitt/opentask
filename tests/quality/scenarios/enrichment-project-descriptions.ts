/**
 * Project descriptions in enrichment (2026-10-16)
 *
 * The enrichment prompt lists each project's description (`projects.
 * description`, what belongs there) after its name. The project rules are
 * unchanged — a project is set only on an explicit instruction or a name
 * match, never from topic — and a description only CHOOSES between projects
 * the words already match:
 * - a partial name in an instruction that fits two projects ("add it to the
 *   rental project" with Oak Rental and Pine Rental) → the one whose
 *   description fits the task
 * - a description never makes a match on its own (a dentist call with a
 *   Health project described as "doctor, dentist" stays null), and never pulls
 *   a task away from the project its words name
 *
 * `filterProjectMatch` (production and this harness) still drops a project
 * none of whose name words are in the input, so a description-only pick would
 * come back null here — the harness logs the model's raw answer when it does.
 */

import type { AITestScenario } from '../types'

const TZ = 'America/Chicago'

const RENTALS = [
  { id: 1, name: 'Inbox', shared: false },
  {
    id: 2,
    name: 'Oak Rental',
    shared: false,
    description: 'Duplex we rent out at 412 Oak St. Tenants: Priya and Dev. Lease renews in March.',
  },
  {
    id: 3,
    name: 'Pine Rental',
    shared: false,
    description: 'Condo at 88 Pine Ave. Vacant, being renovated before we list it.',
  },
  { id: 4, name: 'Home', shared: false, description: null },
]

const SCHOOLS = [
  { id: 1, name: 'Inbox', shared: false },
  {
    id: 2,
    name: 'Ava School',
    shared: false,
    description: 'Ava, 3rd grade at Hillcrest Elementary. Teacher: Ms. Ortiz.',
  },
  {
    id: 3,
    name: 'Sam School',
    shared: false,
    description: 'Sam, 7th grade at Westview Middle School. Band and soccer.',
  },
]

export const enrichmentProjectDescriptionScenarios: AITestScenario[] = [
  {
    id: 'enrich-project-desc-rental-tenant',
    feature: 'enrichment',
    description: 'Instruction fits two projects; the tenant named in one description decides',
    input: {
      text: 'Priya says the dishwasher is leaking again, add it to the rental project',
      timezone: TZ,
      projects: RENTALS,
    },
    requirements: {
      must_include: { project_name: 'Oak Rental', due_at: null, labels: [], rrule: null },
      quality_notes:
        '"the rental project" is an explicit instruction that fits both Oak Rental and Pine Rental. Only Oak Rental\'s description has a tenant named Priya (Pine is vacant), ' +
        'so project_name MUST be "Oak Rental". Title like "Fix the leaking dishwasher" or close to the user\'s words, mentioning Priya or with "Priya says it is leaking again" in notes; ' +
        'the instruction phrase "add it to the rental project" is removed. No date.',
    },
  },
  {
    id: 'enrich-project-desc-rental-renovation',
    feature: 'enrichment',
    description: 'Same two rentals; the renovation in the other description decides',
    input: {
      text: 'get three quotes for the new flooring before we list it, put it in rental',
      timezone: TZ,
      projects: RENTALS,
    },
    requirements: {
      must_include: { project_name: 'Pine Rental', due_at: null, labels: [], rrule: null },
      quality_notes:
        '"put it in rental" fits both rentals. Pine Rental is the one "being renovated before we list it", so project_name MUST be "Pine Rental". ' +
        'Title like "Get three quotes for the new flooring" ("before we list it" in the title or notes). No deadline: "before we list it" has no date.',
    },
  },
  {
    id: 'enrich-project-desc-school',
    feature: 'enrichment',
    description:
      'Instruction "under school" fits two kids\' projects; the school in the description decides',
    input: {
      text: 'buy tickets for the Westview band concert, file it under school',
      timezone: TZ,
      projects: SCHOOLS,
    },
    requirements: {
      must_include: { project_name: 'Sam School', due_at: null, labels: [], rrule: null },
      quality_notes:
        '"under school" fits Ava School and Sam School. Westview (and band) are in Sam School\'s description, so project_name MUST be "Sam School". ' +
        'Title like "Buy tickets for the Westview band concert". No date.',
    },
  },
  {
    id: 'enrich-project-desc-no-match-by-topic',
    feature: 'enrichment',
    description:
      'A description never makes a match: a dentist call with Health described as "dentist"',
    input: {
      text: 'call the dentist to move my cleaning',
      timezone: TZ,
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        {
          id: 2,
          name: 'Health',
          shared: false,
          description: 'Doctor, dentist and eye appointments, prescriptions, the gym.',
        },
        { id: 3, name: 'Work', shared: false, description: 'Day job at the design agency.' },
      ],
    },
    requirements: {
      must_include: { project_name: null, due_at: null, labels: [], rrule: null },
      quality_notes:
        "project_name MUST be null: the words name no project and give no instruction. Health's description mentions dentists, but a description only chooses between " +
        'projects the words already match — what the task is about never counts. (If the run log shows the guard nulled a model answer of "Health", that is a prompt miss even though L1 passes.) ' +
        'Title like "Call the dentist to move my cleaning".',
    },
  },
  {
    id: 'enrich-project-desc-named-stays',
    feature: 'enrichment',
    description:
      'A clearly named project wins over another project whose description fits the topic',
    input: {
      text: 'order tomato cages for the veggie garden',
      timezone: TZ,
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Veggie Garden', shared: false, description: null },
        {
          id: 3,
          name: 'Home',
          shared: false,
          description: 'House and yard: repairs, chores, lawn, garden beds, the shed.',
        },
      ],
    },
    requirements: {
      must_include: { project_name: 'Veggie Garden', due_at: null, labels: [], rrule: null },
      quality_notes:
        'project_name MUST be "Veggie Garden" — the words contain its full name ("for the veggie garden"). Home\'s description mentions garden beds, but a description never pulls a task away ' +
        'from the project its words name. Title "Order tomato cages for the veggie garden" (a name match keeps its words).',
    },
  },
  {
    id: 'enrich-project-desc-work-not-taxes',
    feature: 'enrichment',
    description: 'Name match "for work" holds even when another description lists expense reports',
    input: {
      text: 'print the expense report for work',
      timezone: TZ,
      projects: [
        { id: 1, name: 'Inbox', shared: false },
        { id: 2, name: 'Work', shared: false, description: 'Day job at the design agency.' },
        {
          id: 3,
          name: 'Taxes',
          shared: false,
          description: 'Receipts, expense reports and anything for the accountant.',
        },
      ],
    },
    requirements: {
      must_include: { project_name: 'Work', labels: [], rrule: null },
      quality_notes:
        'project_name MUST be "Work" (name match, "for work"). Taxes\' description mentions expense reports, but it is not named in the words. ' +
        'Title "Print the expense report for work".',
    },
  },
]
