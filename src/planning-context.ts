import { z } from '@hono/zod-openapi'

export const WeekdaySchema = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
])

export const DayPlanningContextSchema = z.object({
  servingsOverride: z.number().int().min(1).optional(),
  occasion: z.enum(['standard', 'guests', 'treat']).optional(),
  effortLevel: z.enum(['standard', 'busy']).optional(),
  leftoversIntent: z.boolean().optional(),
  lateEvening: z.boolean().optional(),
  cookingTolerance: z.enum(['standard', 'relaxed']).optional(),
})

export const HouseholdDaySelectionSchema = z.object({
  day: WeekdaySchema,
  ...DayPlanningContextSchema.shape,
})

export const WeekContextOverrideSchema = DayPlanningContextSchema.refine(
  (value) => Object.values(value).some((entry) => entry !== undefined),
  { message: 'At least one week-specific value is required' },
)

export type TDayPlanningContext = z.infer<typeof DayPlanningContextSchema>
export type THouseholdDaySelection = z.infer<typeof HouseholdDaySelectionSchema>
export type TWeekContextOverride = z.infer<typeof WeekContextOverrideSchema>
export type TMergedDayPlanningContext = TDayPlanningContext & { day?: z.infer<typeof WeekdaySchema> }

export function mergeDayPlanningContext(
  householdDefault: THouseholdDaySelection | undefined,
  weekOverride: TWeekContextOverride | undefined,
): TMergedDayPlanningContext | undefined {
  if (!householdDefault && !weekOverride) return undefined
  return {
    ...(householdDefault ?? {}),
    ...(weekOverride ?? {}),
  }
}
