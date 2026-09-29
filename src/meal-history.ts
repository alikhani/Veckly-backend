import { detectFatiguedMeals, type TWeekMealRecord } from './week-scoring.js'

export type TMealOutcomeHistoryRow = {
  weekStartDate: string
  plannedRecipeId: string
  status: 'cooked' | 'changed_plan' | 'skipped'
  actualRecipeId: string | null
}

export type TResolvedMealHistory = {
  // Safe internal fallback for recency/fatigue: confirmed outcomes whenever
  // a week has any, otherwise that legacy week's plan assignments.
  scoringRecords: TWeekMealRecord[]
  // Exact facts only. Never mix these with legacy assignments in user-facing
  // "cooked" counts or streaks.
  confirmedRecords: TWeekMealRecord[]
  legacyPlannedRecords: TWeekMealRecord[]
}

export function cookedRecipeIdFromOutcome(outcome: TMealOutcomeHistoryRow): string | null {
  if (outcome.status === 'cooked') return outcome.plannedRecipeId
  if (outcome.status === 'changed_plan') return outcome.actualRecipeId
  return null
}

// A week switches atomically from legacy-plan fallback to outcomes as soon as
// its first outcome exists. Missing outcomes inside a partially recorded week
// remain unknown; treating their assignments as cooked would recreate the
// exact false-history problem this model is meant to fix.
export function resolveMealHistory(
  plannedRecords: TWeekMealRecord[],
  outcomes: TMealOutcomeHistoryRow[],
): TResolvedMealHistory {
  const plansByWeek = new Map(plannedRecords.map((record) => [record.weekStartDate, record.mealIds]))
  const outcomesByWeek = new Map<string, TMealOutcomeHistoryRow[]>()
  for (const outcome of outcomes) {
    const rows = outcomesByWeek.get(outcome.weekStartDate) ?? []
    rows.push(outcome)
    outcomesByWeek.set(outcome.weekStartDate, rows)
  }

  const weekStartDates = Array.from(new Set([...plansByWeek.keys(), ...outcomesByWeek.keys()])).sort()
  const scoringRecords: TWeekMealRecord[] = []
  const confirmedRecords: TWeekMealRecord[] = []
  const legacyPlannedRecords: TWeekMealRecord[] = []

  for (const weekStartDate of weekStartDates) {
    const weekOutcomes = outcomesByWeek.get(weekStartDate)
    if (weekOutcomes && weekOutcomes.length > 0) {
      const mealIds = weekOutcomes
        .map(cookedRecipeIdFromOutcome)
        .filter((recipeId): recipeId is string => recipeId !== null)
      const record = { weekStartDate, mealIds }
      confirmedRecords.push(record)
      scoringRecords.push(record)
      continue
    }

    const legacyRecord = { weekStartDate, mealIds: plansByWeek.get(weekStartDate) ?? [] }
    legacyPlannedRecords.push(legacyRecord)
    scoringRecords.push(legacyRecord)
  }

  return { scoringRecords, confirmedRecords, legacyPlannedRecords }
}

export function recipeIdsFromRecords(records: TWeekMealRecord[]): Set<string> {
  return new Set(records.flatMap((record) => record.mealIds))
}

// User-facing "back after a break" copy needs a fully confirmed recent
// timeline. We only inspect the contiguous confirmed suffix ending last week;
// an unknown legacy week breaks provenance and suppresses the claim.
export function detectConfirmedFatiguedMeals(
  expectedWeekStartDates: string[],
  confirmedRecords: TWeekMealRecord[],
): string[] {
  const confirmedByDate = new Map(confirmedRecords.map((record) => [record.weekStartDate, record]))
  const sortedDates = [...expectedWeekStartDates].sort()
  const confirmedSuffix: TWeekMealRecord[] = []
  for (let index = sortedDates.length - 1; index >= 0; index--) {
    const record = confirmedByDate.get(sortedDates[index]!)
    if (!record) break
    confirmedSuffix.unshift(record)
  }
  return detectFatiguedMeals(confirmedSuffix)
}
