/**
 * Process scenarios (2026-10-10) — the AI half of the Process button
 *
 * Project recommendations: the AI recommends, the user picks. Topic is
 * allowed here (unlike enrichment) because nothing is applied without the
 * user, but a wrong pick still costs a correction, so the bar is "clearly
 * fits, else null". Descriptions say what belongs in a project and should
 * outweigh the bare name.
 *
 * Duplicates: conservative. A false group wastes the user's review; related
 * but different work must not be grouped.
 */

import type { AITestScenario } from '../types'

const task = (id: number, title: string, notes: string | null = null) => ({ id, title, notes })

export const processScenarios: AITestScenario[] = [
  {
    id: 'process-projects-clear-fits',
    feature: 'process_projects',
    description: 'Clear fits go to the described project; a vague task gets null',
    input: {
      projects: [
        {
          id: 2,
          name: 'Work',
          description: 'Freelance client deliverables, invoices and meetings',
        },
        { id: 3, name: 'Home', description: 'House maintenance, chores and the yard' },
        { id: 4, name: 'Health', description: 'Doctor, dentist, meds and exercise' },
        {
          id: 5,
          name: 'Job Search',
          description: 'Applications, recruiter calls, resume and interview prep',
        },
        { id: 6, name: 'Shopping List', description: 'Things to pick up at the store' },
      ],
      tasks: [
        task(101, 'Send invoice to Acme for September'),
        task(102, 'Replace furnace filter'),
        task(103, 'Schedule dentist cleaning'),
        task(104, 'Follow up with the recruiter from Stripe'),
        task(105, 'Paper towels'),
        task(106, 'Think about that thing Sam said'),
        task(107, 'Update resume with the Acme project'),
        task(108, 'Buy a birthday gift for Dana'),
      ],
    },
    requirements: {
      process_expectations: {
        projects: { 101: 2, 102: 3, 103: 4, 104: 5, 105: 6, 106: null, 107: 5 },
      },
      quality_notes:
        'One entry per task. 101 Work, 102 Home, 103 Health, 104 Job Search, 105 Shopping List, 107 Job Search (resume is in its description). ' +
        '106 must be null — nothing in it says where it belongs. 108 (gift) is ambiguous: Shopping List or null are both fine. ' +
        'Reasons are one short sentence and name what matched (e.g. "invoice → client billing").',
    },
  },
  {
    id: 'process-projects-descriptions-and-context',
    feature: 'process_projects',
    description: 'Descriptions outweigh names; user context resolves a person',
    input: {
      userContext: 'Dana is my wife. We have two kids, Ellie and Sam.',
      projects: [
        { id: 2, name: 'Admin', description: 'Bills, taxes, insurance and banking' },
        { id: 3, name: 'Errands', description: 'Anything that needs a car trip' },
        { id: 4, name: 'Family', description: 'Dana and the kids' },
        { id: 5, name: 'Work', description: null },
      ],
      tasks: [
        task(201, 'Pay the water bill'),
        task(202, 'Return the library books'),
        task(203, 'Call insurance about the claim', 'Claim #A-4829'),
        task(204, "Plan Dana's birthday dinner"),
        task(205, 'Learn to play the banjo'),
        task(206, "Pick up Ellie's EpiPen at the pharmacy"),
      ],
    },
    requirements: {
      process_expectations: {
        projects: { 201: 2, 202: 3, 203: 2, 204: 4, 205: null },
      },
      quality_notes:
        '201 Admin (bills), 202 Errands (a car trip), 203 Admin (insurance), 204 Family (Dana — from context), 205 null (no project fits a hobby). ' +
        '206 is a car trip AND a kid: Errands or Family are both reasonable; null acceptable. ' +
        'Work has no description and no task fits it — it must not be recommended.',
    },
  },
  {
    id: 'process-duplicates-mixed',
    feature: 'process_duplicates',
    description: 'True duplicates grouped; related-but-different work kept apart',
    input: {
      tasks: [
        task(301, 'Call the dentist'),
        task(302, 'Phone dentist about the cleaning'),
        task(303, 'Buy paint'),
        task(304, 'Paint the fence'),
        task(305, 'Email Sam about the invoice'),
        task(306, 'Email Jordan about the invoice'),
        task(307, 'Renew passport'),
        task(308, 'renew my passport before the trip', 'Need new photos'),
        task(309, 'Pay rent'),
        task(310, 'Pay the electric bill'),
        task(311, 'Cancel M365'),
        task(312, 'Cancel the Microsoft 365 subscription'),
        task(313, 'Fix the squeaky hinge on the back door'),
        task(314, 'Order more printer ink'),
        task(315, 'Call mom'),
        task(316, 'Visit mom this weekend'),
        task(317, 'Clean out the garage'),
        task(318, 'Schedule an oil change'),
      ],
    },
    requirements: {
      process_expectations: {
        duplicate_groups: [
          [301, 302],
          [307, 308],
          [311, 312],
        ],
        not_duplicates: [
          [303, 304],
          [305, 306],
          [309, 310],
          [315, 316],
        ],
      },
      quality_notes:
        'Exactly the three true duplicate pairs: dentist call (301/302), passport (307/308), Microsoft 365 (311/312). ' +
        'Paint vs fence, Sam vs Jordan, rent vs electric, call vs visit mom are different work and must not be grouped. ' +
        'No other groups. Reasons short and specific.',
    },
  },
  {
    id: 'process-duplicates-none',
    feature: 'process_duplicates',
    description: 'A list with only near-misses returns no groups',
    input: {
      tasks: [
        task(401, 'Email Sam about the invoice'),
        task(402, 'Email Sam about the contract'),
        task(403, 'Buy dog food'),
        task(404, 'Buy cat litter'),
        task(405, 'Call the plumber'),
        task(406, 'Call the electrician'),
        task(407, 'Book flights to Denver'),
        task(408, 'Book a hotel in Denver'),
      ],
    },
    requirements: {
      process_expectations: {
        not_duplicates: [
          [401, 402],
          [403, 404],
          [405, 406],
          [407, 408],
        ],
      },
      quality_notes:
        'groups must be empty — every pair shares words but is different work. Any group is a failure.',
    },
  },
]
