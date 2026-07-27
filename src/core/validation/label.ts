/**
 * Label registry validation (REDESIGN-V03 §7.2)
 */

import { z } from 'zod'
import { LABEL_COLOR_NAMES } from '@/lib/label-colors'

/**
 * `facet` groups labels for the chip bar, where semantics are AND across facets
 * and OR within one. `operational` labels carry behavior (provenance, state);
 * `domain` labels carry meaning (nutrition, kids, house).
 */
const facet = z.enum(['domain', 'operational'])

export const labelCreateSchema = z.object({
  name: z.string().trim().min(1, 'Label name is required').max(100, 'Label name too long'),
  facet: facet.default('domain'),
  icon: z.string().max(100).nullable().optional(),
  color: z
    .enum(LABEL_COLOR_NAMES as unknown as [string, ...string[]])
    .nullable()
    .optional(),
})

export type LabelCreateInput = z.infer<typeof labelCreateSchema>

export function validateLabelCreate(input: unknown): LabelCreateInput {
  return labelCreateSchema.parse(input)
}
