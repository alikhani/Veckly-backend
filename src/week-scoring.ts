// Ported from MealPlanner's proven web scoring engine
// (src/lib/planner/meal-scoring.ts, week-constraint-scoring.ts,
// week-history-analysis.ts) — same formulas, adapted to this backend's
// recipe-row and feedback-row shapes. Kept as pure functions (no DB access)
// so they're unit-testable without a database, matching the web engine's
// own test structure.
import { canonicalIngredientItemKey, pantryCoversIngredient } from './ingredient-identity.js'

export type TScoringRecipe = {
  id: string
  title: string
  tags: string[]
  ingredients: Array<{ item: string; unit?: string | null; category?: string | null }> | null
  servings: number
  prepTimeMinutes: number | null
  cuisine: string | null
  proteinSource: string | null
  mealWeight: string | null
  householdId: string | null
}

export type TDaySelection = {
  day?: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
  occasion?: 'standard' | 'guests' | 'treat'
  effortLevel?: 'standard' | 'busy'
  leftoversIntent?: boolean
  lateEvening?: boolean
  cookingTolerance?: 'standard' | 'relaxed'
  servingsOverride?: number
}

export type TFeedbackVote = 'up' | 'down'
export type TFeedbackSignal =
  | 'easy-weeknight'
  | 'family-approved'
  | 'good-leftovers'
  | 'too-much-effort'
  | 'family-pushback'
  | 'poor-leftovers'

export type TFeedbackEntry = { vote: TFeedbackVote; signal?: TFeedbackSignal }
export type TFeedbackState = Record<string, TFeedbackEntry>
export type THouseholdMealSignal = 'works_for_family' | 'not_for_us'
export type THouseholdMealSignalState = Record<string, THouseholdMealSignal>

export type TRecentMealIds = { lastWeek: string[]; twoWeeksAgo: string[] }

export type TWeekMealRecord = { weekStartDate: string; mealIds: string[] }

const directSignalScoreMap: Record<TFeedbackSignal, number> = {
  'easy-weeknight': 3,
  'family-approved': 3,
  'good-leftovers': 2,
  'too-much-effort': -4,
  'family-pushback': -5,
  'poor-leftovers': -3,
}

const feedbackSignalTagMap: Record<TFeedbackSignal, string[]> = {
  'easy-weeknight': ['quick', 'meal-prep'],
  'family-approved': ['child-friendly'],
  'good-leftovers': ['leftovers', 'meal-prep'],
  'too-much-effort': ['treat', 'guests'],
  'family-pushback': ['child-friendly'],
  'poor-leftovers': ['leftovers', 'meal-prep'],
}

function getSignalScore(entry: TFeedbackEntry | undefined): number {
  return entry?.signal ? directSignalScoreMap[entry.signal] : 0
}

function scoreSignalSimilarity(recipe: TScoringRecipe, entry: TFeedbackEntry | undefined): number {
  if (!entry?.signal) return 0
  const mappedTags = feedbackSignalTagMap[entry.signal]
  const overlap = mappedTags.filter((tag) => recipe.tags.includes(tag)).length
  if (overlap === 0) return 0
  return Math.min(2, overlap) * 1.5 * (entry.vote === 'up' ? 1 : -1)
}

/** Explicit vote on this exact recipe (+8/-12), or spillover from other
 * voted recipes that share tags (±1.25/±1.1 per shared tag, capped). */
export function scoreMealFromFeedback(recipe: TScoringRecipe, feedback: TFeedbackState, allRecipes: TScoringRecipe[]): number {
  const explicitEntry = feedback[recipe.id]
  const explicitVote = explicitEntry?.vote
  if (explicitVote === 'up') return 8 + getSignalScore(explicitEntry)
  if (explicitVote === 'down') return -12 + getSignalScore(explicitEntry)

  let score = 0
  for (const other of allRecipes) {
    const entry = feedback[other.id]
    const vote = entry?.vote
    if (!vote || other.id === recipe.id) continue
    const sharedTags = other.tags.filter((tag) => recipe.tags.includes(tag)).length
    if (sharedTags === 0) continue
    if (vote === 'up') score += Math.min(3, sharedTags) * 1.25
    if (vote === 'down') score -= Math.min(2, sharedTags) * 1.1
    score += scoreSignalSimilarity(recipe, entry)
  }
  return score
}

/** Penalize a recipe that was just cooked, so the week doesn't repeat itself. */
export function scoreRecency(recipe: TScoringRecipe, recentMealIds: TRecentMealIds | undefined): number {
  if (!recentMealIds) return 0
  if (recentMealIds.lastWeek.includes(recipe.id)) return -8
  if (recentMealIds.twoWeeksAgo.includes(recipe.id)) return -4
  return 0
}

/** A recipe that ran ≥3 consecutive weeks and was then dropped gets a
 * 2-week cooldown penalty — the household deliberately took a break from it. */
export function scoreFatigue(recipe: TScoringRecipe, fatiguedMealIds: string[] | undefined): number {
  return fatiguedMealIds?.includes(recipe.id) ? -10 : 0
}

/** A recipe the household created themselves (fork, import, or from
 * scratch) is preferred over the shared curated library. */
export function scoreFamilyRecipe(recipe: TScoringRecipe, householdId: string): number {
  return recipe.householdId === householdId ? 12 : 0
}

export function scoreHouseholdMealSignal(recipe: TScoringRecipe, householdSignals: THouseholdMealSignalState | undefined): number {
  const signal = householdSignals?.[recipe.id]
  if (signal === 'works_for_family') return 10
  if (signal === 'not_for_us') return -20
  return 0
}

function scoreOccasion(recipe: TScoringRecipe, selection: TDaySelection | undefined): number {
  if (!selection) return 0
  let score = 0
  if (selection.occasion === 'treat' && recipe.tags.includes('treat')) score += 5
  if (selection.occasion === 'guests' && recipe.tags.includes('guests')) score += 6
  if (selection.servingsOverride && selection.servingsOverride > recipe.servings && recipe.tags.includes('guests')) score += 2
  return score
}

export function scoreEffortAndLeftovers(recipe: TScoringRecipe, selection: TDaySelection | undefined): number {
  if (!selection) return 0
  let score = 0
  const prepTime = recipe.prepTimeMinutes ?? 0
  if (selection.effortLevel === 'busy') {
    if (recipe.tags.includes('quick')) score += 6
    if (recipe.tags.includes('meal-prep')) score += 1.5
    score -= Math.max(0, prepTime - 30) / 4
  }
  if (selection.leftoversIntent) {
    if (recipe.tags.includes('leftovers')) score += 5
    if (recipe.tags.includes('meal-prep')) score += 2
  }
  return score
}

export function scoreLateEvening(recipe: TScoringRecipe, selection: TDaySelection | undefined): number {
  if (!selection?.lateEvening) return 0
  const prepTime = recipe.prepTimeMinutes ?? 0
  let score = 0
  if (recipe.tags.includes('quick')) score += 5
  if (recipe.tags.includes('meal-prep')) score += 1
  if (recipe.tags.includes('treat') || recipe.tags.includes('guests')) score -= 2
  score -= Math.max(0, prepTime - 25) / 4
  return score
}

export function scoreCookingTolerance(recipe: TScoringRecipe, selection: TDaySelection | undefined): number {
  if (selection?.cookingTolerance !== 'relaxed') return 0
  let score = 0
  if (recipe.tags.includes('treat') || recipe.tags.includes('guests')) score += 3
  if ((recipe.prepTimeMinutes ?? 0) >= 35) score += 2
  return score
}

export function scoreDayPlanningContext(recipe: TScoringRecipe, selection: TDaySelection | undefined): number {
  return scoreOccasion(recipe, selection)
    + scoreEffortAndLeftovers(recipe, selection)
    + scoreLateEvening(recipe, selection)
    + scoreCookingTolerance(recipe, selection)
}

export type TWeekContext = {
  placedCuisines: Record<string, number>
  placedProteins: Record<string, number>
  placedWeights: Array<string | null>
  ingredientUseCounts: Record<string, number>
  pantryStock: Record<string, number>
  pantryIngredientWeight: number
}

export function createWeekContext(pantryStock: Record<string, number> = {}, pantryIngredientWeight = 0.75): TWeekContext {
  return { placedCuisines: {}, placedProteins: {}, placedWeights: [], ingredientUseCounts: {}, pantryStock, pantryIngredientWeight }
}

/** Penalizes repeating the same cuisine/protein a 3rd+ time in the week, and
 * placing two "hearty" meals back to back. */
export function scoreWeekConstraints(recipe: TScoringRecipe, ctx: TWeekContext): number {
  let score = 0

  if (recipe.cuisine) {
    const count = ctx.placedCuisines[recipe.cuisine] ?? 0
    if (count >= 2) score -= 6 * (count - 1)
  }

  if (recipe.proteinSource) {
    const count = ctx.placedProteins[recipe.proteinSource] ?? 0
    if (count >= 2) score -= 5 * (count - 1)
  }

  const lastWeight = ctx.placedWeights[ctx.placedWeights.length - 1]
  if (recipe.mealWeight === 'hearty' && lastWeight === 'hearty') score -= 4

  return score
}

export function updateWeekContext(ctx: TWeekContext, recipe: TScoringRecipe): void {
  if (recipe.cuisine) ctx.placedCuisines[recipe.cuisine] = (ctx.placedCuisines[recipe.cuisine] ?? 0) + 1
  if (recipe.proteinSource) ctx.placedProteins[recipe.proteinSource] = (ctx.placedProteins[recipe.proteinSource] ?? 0) + 1
  ctx.placedWeights.push(recipe.mealWeight)
  for (const key of recipeIngredientKeys(recipe)) {
    ctx.ingredientUseCounts[key] = (ctx.ingredientUseCounts[key] ?? 0) + 1
  }
}

const ECONOMY_EXCLUDED_ITEMS = new Set([
  'salt', 'salt and pepper', 'pepper', 'black pepper', 'water', 'oil', 'olive oil',
  'salt och peppar', 'svartpeppar', 'vatten', 'olja', 'olivolja',
])

function recipeIngredients(recipe: TScoringRecipe) {
  return (recipe.ingredients ?? []).filter((ingredient) => {
    const item = ingredient.item.trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ')
    return item.length > 0 && !ECONOMY_EXCLUDED_ITEMS.has(item)
  })
}

export function recipeIngredientKeys(recipe: TScoringRecipe) {
  return new Set(recipeIngredients(recipe).map(canonicalIngredientItemKey))
}

export function scoreIngredientEconomy(
  recipe: TScoringRecipe,
  ctx: TWeekContext,
  preferredPrepRecipeIds: Set<string> | undefined,
) {
  const ingredients = recipeIngredients(recipe)
  const keys = new Set(ingredients.map(canonicalIngredientItemKey))
  const overlapCount = [...keys].filter((key) => (ctx.ingredientUseCounts[key] ?? 0) > 0).length
  const pantryCount = ingredients.filter((ingredient) => pantryCoversIngredient(ingredient, ctx.pantryStock)).length
  const newCount = [...keys].filter((key) => (ctx.ingredientUseCounts[key] ?? 0) === 0).length
  const prepChainScore = preferredPrepRecipeIds?.has(recipe.id) ? 14 : 0
  return prepChainScore
    + Math.min(3, overlapCount) * 1.25
    + Math.min(3, pantryCount) * ctx.pantryIngredientWeight
    - Math.min(10, newCount) * 0.15
}

export type TWeekEconomyMetrics = {
  uniqueIngredientCount: number
  uniquePurchaseCount: number
  pantryCoveredIngredientCount: number
  reusedIngredientCount: number
}

export function evaluateWeekEconomy(recipes: TScoringRecipe[], pantryStock: Record<string, number>): TWeekEconomyMetrics {
  const useCounts = new Map<string, number>()
  const pantryCovered = new Set<string>()
  for (const recipe of recipes) {
    const ingredients = recipeIngredients(recipe)
    const keysForRecipe = new Set(ingredients.map(canonicalIngredientItemKey))
    for (const key of keysForRecipe) useCounts.set(key, (useCounts.get(key) ?? 0) + 1)
    for (const ingredient of ingredients) {
      if (pantryCoversIngredient(ingredient, pantryStock)) pantryCovered.add(canonicalIngredientItemKey(ingredient))
    }
  }
  return {
    uniqueIngredientCount: useCounts.size,
    uniquePurchaseCount: Math.max(0, useCounts.size - pantryCovered.size),
    pantryCoveredIngredientCount: pantryCovered.size,
    reusedIngredientCount: [...useCounts.values()].filter((count) => count >= 2).length,
  }
}

export function compareApprovedWeeksByEconomy(
  left: TScoringRecipe[],
  right: TScoringRecipe[],
  pantryStock: Record<string, number>,
) {
  const leftMetrics = evaluateWeekEconomy(left, pantryStock)
  const rightMetrics = evaluateWeekEconomy(right, pantryStock)
  const purchaseDifference = leftMetrics.uniquePurchaseCount - rightMetrics.uniquePurchaseCount
  if (purchaseDifference !== 0) return purchaseDifference
  const reuseDifference = rightMetrics.reusedIngredientCount - leftMetrics.reusedIngredientCount
  if (reuseDifference !== 0) return reuseDifference
  return left.map((recipe) => recipe.id).join('|').localeCompare(right.map((recipe) => recipe.id).join('|'))
}

export type TScoringContext = {
  householdId: string
  feedback: TFeedbackState
  householdSignals?: THouseholdMealSignalState
  allRecipes: TScoringRecipe[]
  weekCtx: TWeekContext
  selection?: TDaySelection
  recentMealIds?: TRecentMealIds
  fatiguedMealIds?: string[]
  preferredPrepRecipeIds?: Set<string>
  wishedMeals?: string[]
}

export function normalizedMealWish(value: string) {
  return value.trim().toLocaleLowerCase('sv-SE').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

export function recipeMatchesWish(recipeTitle: string, wishedMeal: string) {
  const title = normalizedMealWish(recipeTitle)
  const wish = normalizedMealWish(wishedMeal)
  return wish.length >= 2 && (title === wish || title.includes(wish) || wish.includes(title))
}

export function scoreMeal(recipe: TScoringRecipe, ctx: TScoringContext): number {
  let score = 0
  score += scoreFamilyRecipe(recipe, ctx.householdId)
  score += scoreDayPlanningContext(recipe, ctx.selection)
  score += scoreHouseholdMealSignal(recipe, ctx.householdSignals)
  score += scoreMealFromFeedback(recipe, ctx.feedback, ctx.allRecipes)
  score += scoreWeekConstraints(recipe, ctx.weekCtx)
  score += scoreRecency(recipe, ctx.recentMealIds)
  score += scoreFatigue(recipe, ctx.fatiguedMealIds)
  score += scoreIngredientEconomy(recipe, ctx.weekCtx, ctx.preferredPrepRecipeIds)
  if (ctx.wishedMeals?.some((wish) => recipeMatchesWish(recipe.title, wish))) score += 18
  return score
}

/** Highest score first; ties break on recipe id so results are
 * deterministic (no randomness in the ranking itself — matches the web
 * engine, which has none either). */
export function rankCandidates(candidates: TScoringRecipe[], ctx: TScoringContext): TScoringRecipe[] {
  return [...candidates].sort((left, right) => {
    const diff = scoreMeal(right, ctx) - scoreMeal(left, ctx)
    if (diff !== 0) return diff
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  })
}

/** Ported verbatim from week-history-analysis.ts. `records` must be sorted
 * ascending by weekStartDate already isn't required — this sorts internally. */
export function extractRecentMealIds(records: TWeekMealRecord[], currentWeekStart: string): TRecentMealIds {
  const current = new Date(`${currentWeekStart}T00:00:00Z`).getTime()
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000

  const lastWeek: string[] = []
  const twoWeeksAgo: string[] = []

  for (const record of records) {
    const recordTime = new Date(`${record.weekStartDate}T00:00:00Z`).getTime()
    const weeksAgo = Math.round((current - recordTime) / MS_PER_WEEK)
    if (weeksAgo === 1) lastWeek.push(...record.mealIds)
    else if (weeksAgo === 2) twoWeeksAgo.push(...record.mealIds)
  }

  return { lastWeek, twoWeeksAgo }
}

type TMealStreakState = { streak: number; streakBroke: boolean; weeksSinceBreak: number }

function processWeekRecord(state: TMealStreakState, present: boolean): TMealStreakState {
  if (present) {
    return { streak: state.streak + 1, streakBroke: false, weeksSinceBreak: state.streakBroke ? 0 : state.weeksSinceBreak }
  }
  if (state.streak >= 3 && !state.streakBroke) {
    return { streak: 0, streakBroke: true, weeksSinceBreak: 0 }
  }
  return { streak: 0, streakBroke: state.streakBroke, weeksSinceBreak: state.streakBroke ? state.weeksSinceBreak + 1 : state.weeksSinceBreak }
}

export type TAssignmentReason = 'family-recipe' | 'liked-before' | 'back-after-break' | 'based-on-feedback' | 'new-for-variety' | 'quick-weekday' | 'week-override'
export type TAssignmentConfidence = 'ok' | 'low'

export type TReasonContext = {
  householdId: string
  feedback: TFeedbackState
  allRecipes: TScoringRecipe[]
  selection?: TDaySelection
  fatiguedMealIds?: string[]
  everCookedRecipeIds?: Set<string>
  legacyPlannedRecipeIds?: Set<string>
  selectionSource?: 'household-default' | 'week-override'
}

/** Picks the single most salient explanation for why this recipe won its
 * slot — checked in order of how specific/informative the signal is to the
 * user, not how strongly it scored. An explicit vote outranks mere
 * ownership: "you liked this" is more meaningful than "it's your own
 * recipe" when both are true (the latter is redundant — they already know
 * it's theirs). Day-level signals are intentionally reduced to the one
 * user-facing reason this backend exposes today: a quick fit for a busy or
 * late evening. */
export function deriveAssignmentReason(recipe: TScoringRecipe, ctx: TReasonContext): TAssignmentReason | undefined {
  if (ctx.selectionSource === 'week-override' && scoreDayPlanningContext(recipe, ctx.selection) > 0) return 'week-override'
  if (ctx.feedback[recipe.id]?.vote === 'up') return 'liked-before'
  if (recipe.householdId === ctx.householdId) return 'family-recipe'
  if ((ctx.selection?.effortLevel === 'busy' || ctx.selection?.lateEvening) && recipe.tags.includes('quick')) return 'quick-weekday'
  if (ctx.fatiguedMealIds?.includes(recipe.id)) return 'back-after-break'
  if (scoreMealFromFeedback(recipe, ctx.feedback, ctx.allRecipes) > 0) return 'based-on-feedback'
  if (
    ctx.everCookedRecipeIds
    && !ctx.everCookedRecipeIds.has(recipe.id)
    && !ctx.legacyPlannedRecipeIds?.has(recipe.id)
  ) return 'new-for-variety'
  return undefined
}

/** Ported from `evaluateConfidence` in week-constraint-scoring.ts. Must be
 * called with the week context as it stood *before* this recipe was placed —
 * same call order as the web engine. */
export function evaluateAssignmentConfidence(recipe: TScoringRecipe, weekCtx: TWeekContext, selection?: TDaySelection): TAssignmentConfidence {
  if (recipe.mealWeight === 'hearty' && selection?.effortLevel === 'busy') return 'low'
  const lastWeight = weekCtx.placedWeights[weekCtx.placedWeights.length - 1]
  if (recipe.mealWeight === 'hearty' && lastWeight === 'hearty') return 'low'
  if (recipe.cuisine && (weekCtx.placedCuisines[recipe.cuisine] ?? 0) >= 2) return 'low'
  if (recipe.proteinSource && (weekCtx.placedProteins[recipe.proteinSource] ?? 0) >= 2) return 'low'
  return 'ok'
}

/** Ported verbatim from week-history-analysis.ts. Returns meal IDs that
 * appeared ≥3 consecutive weeks and were then skipped — penalized for 2
 * weeks after the skip. */
export function detectFatiguedMeals(records: TWeekMealRecord[]): string[] {
  if (records.length < 4) return []

  const sorted = [...records].sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate))
  const fatigued = new Set<string>()
  const allIds = new Set(sorted.flatMap((r) => r.mealIds))

  for (const mealId of allIds) {
    let state: TMealStreakState = { streak: 0, streakBroke: false, weeksSinceBreak: 0 }
    for (const record of sorted) {
      state = processWeekRecord(state, record.mealIds.includes(mealId))
    }
    if (state.streakBroke && state.weeksSinceBreak < 2) fatigued.add(mealId)
  }

  return Array.from(fatigued)
}

/** How many consecutive weeks (counting the current week) a recipe has been
 * cooked, most-recent-first. `weeksMostRecentFirst[0]` is the current week's
 * meal IDs; counting stops at the first week that doesn't contain the recipe.
 * Used for D4's satiation hint — a lightweight, presentation-only signal
 * (no scoring/generation impact), unlike `detectFatiguedMeals`. */
export function computeCurrentStreak(recipeId: string, weeksMostRecentFirst: string[][]): number {
  let streak = 0
  for (const weekMealIds of weeksMostRecentFirst) {
    if (!weekMealIds.includes(recipeId)) break
    streak++
  }
  return streak
}
