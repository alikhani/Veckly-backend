import type { Db } from './db.js'
import type { CausedBySchema, ShoppingStatePayloadSchema } from './modules/shopping-list/schemas.js'
import type { z } from 'zod'
import {
  emptyProjectionState,
  foldEventIntoProjection,
  type TShoppingListProjectionState,
} from './modules/shopping-list/projection.js'
import {
  getShoppingListState as getShoppingListStateUseCase,
  getShoppingListSummary as getShoppingListSummaryUseCase,
  replaceShoppingListState as replaceShoppingListStateUseCase,
} from './modules/shopping-list/service.js'
import type { TShoppingListLanguage } from './modules/shopping-list/localization.js'

export { buildShoppingListRoutes } from './modules/shopping-list/index.js'

// Old-signature wrappers kept for test/shopping-list.test.ts until the shim is removed.
function getShoppingListState(db: Db, accessToken: string, householdId: string, weekStartDate: string) {
  return getShoppingListStateUseCase({ db, accessToken, householdId }, weekStartDate)
}

function replaceShoppingListState(
  db: Db,
  accessToken: string,
  args: {
    householdId: string
    weekStartDate: string
    causedBy: z.infer<typeof CausedBySchema>
    expectedUpdatedAt?: string | null
    state: z.infer<typeof ShoppingStatePayloadSchema> | null
  },
) {
  const { householdId, ...rest } = args
  return replaceShoppingListStateUseCase({ db, accessToken, householdId }, rest)
}

export function getShoppingListSummary(
  db: Db,
  accessToken: string,
  householdId: string,
  weekStartDate: string,
  options: { language?: TShoppingListLanguage; today?: string } = {},
) {
  return getShoppingListSummaryUseCase({ db, accessToken, householdId }, weekStartDate, options)
}

// Exported for tests that need to seed projection rows directly (bypassing
// appendShoppingListEvent) to prove the read path reflects the projection,
// never a replay of the log — same rationale as week-plan's exports.
export { foldEventIntoProjection, emptyProjectionState, getShoppingListState, replaceShoppingListState }
export type { TShoppingListProjectionState }
