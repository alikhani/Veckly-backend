import { z } from '@hono/zod-openapi'

// --- Wire shapes -----------------------------------------------------------
//
// Same flat-envelope shape as week-plan's events — `{ causedBy, eventType,
// ...fields }` — for the same reason: `eventType` is both the Zod
// discriminant and the queryable `event_type` column.

export const CausedBySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('user'), userId: z.string().uuid() }),
  z.object({ source: z.literal('algorithm'), algorithmVersion: z.string(), triggeredByUserId: z.string().uuid() }),
  z.object({ source: z.literal('system'), reason: z.string() }),
]).openapi('ShoppingListCausedBy')

// Minimal lifecycle marker — mirrors week-plan's `WeekStarted`. Proves the
// stream has a start; the architecture doc's "shopping-list:<date>" framing
// names the stream key (household + week) but doesn't yet specify the full
// event vocabulary — that's future work, not this slice's job to pin down.
const ListStartedPayloadSchema = z.object({
  eventType: z.literal('list_started'),
})

// `itemKey` is a placeholder freeform identifier, not a real FK — shopping
// list items don't have a domain model yet (same situation `recipeRef` names
// in week-plan's `MealAssigned`: coupling the event-sourcing proof to a
// domain that doesn't exist would be backwards).
const ItemCheckedPayloadSchema = z.object({
  eventType: z.literal('item_checked'),
  itemKey: z.string().min(1),
  checked: z.boolean(),
})

export const ShoppingStatePayloadSchema = z.object({
  checkedItems: z.array(z.string().min(1)),
  pantryStock: z.record(z.string(), z.number().finite()),
  customItems: z.array(
    z.object({
      itemKey: z.string().min(1),
      label: z.string().min(1),
      category: z.string().min(1),
    }),
  ).optional().default([]),
}).openapi('ShoppingStatePayload')

const ShoppingStateReplacedPayloadSchema = z.object({
  eventType: z.literal('shopping_state_replaced'),
  state: ShoppingStatePayloadSchema,
})

const ShoppingListClearedPayloadSchema = z.object({
  eventType: z.literal('shopping_list_cleared'),
})

export const ShoppingListEventPayloadSchema = z.discriminatedUnion('eventType', [
  ListStartedPayloadSchema,
  ItemCheckedPayloadSchema,
  ShoppingStateReplacedPayloadSchema,
  ShoppingListClearedPayloadSchema,
])

export const AppendShoppingListEventRequestSchema = z.object({
  causedBy: CausedBySchema,
}).and(ShoppingListEventPayloadSchema).openapi('AppendShoppingListEventRequest')

export const ShoppingListEventSchema = z.object({
  id: z.string().uuid(),
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  sequenceNumber: z.number().int(),
  occurredAt: z.string(),
  causedBy: CausedBySchema,
  eventType: z.enum(['list_started', 'item_checked', 'shopping_state_replaced', 'shopping_list_cleared']),
  payload: z.record(z.string(), z.unknown()),
}).openapi('ShoppingListEvent')

export const ShoppingListProjectionSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string(),
  state: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
}).openapi('ShoppingListProjection')

export const ParamsSchema = z.object({
  householdId: z.string().uuid(),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
})

const ShoppingListSummaryItemSchema = z.object({
  itemKey: z.string(),
  label: z.string(),
  amount: z.string().nullable(),
  unit: z.string().nullable(),
  checked: z.boolean(),
  isCustom: z.boolean(),
}).openapi('ShoppingListSummaryItem')

const ShoppingListSummaryGroupSchema = z.object({
  category: z.string(),
  items: z.array(ShoppingListSummaryItemSchema),
}).openapi('ShoppingListSummaryGroup')

export const ShoppingListSummarySchema = z.object({
  household: z.object({ id: z.string().uuid(), name: z.string() }),
  weekStartDate: z.string(),
  updatedAt: z.string().nullable(),
  groups: z.array(ShoppingListSummaryGroupSchema),
}).openapi('ShoppingListSummary')

export const ShoppingListStateResponseSchema = z.object({
  state: ShoppingStatePayloadSchema.nullable(),
  updatedAt: z.string().nullable(),
}).openapi('ShoppingListStateResponse')

export const UpdateShoppingListStateRequestSchema = z.object({
  expectedUpdatedAt: z.string().nullable().optional(),
  state: ShoppingStatePayloadSchema.nullable(),
}).openapi('UpdateShoppingListStateRequest')

export const UpdateShoppingListStateResponseSchema = z.object({
  ok: z.literal(true),
  updatedAt: z.string().nullable(),
}).openapi('UpdateShoppingListStateResponse')

export const StaleShoppingListStateResponseSchema = z.object({
  error: z.literal('STALE_SHOPPING_STATE'),
  updatedAt: z.string().nullable(),
}).openapi('StaleShoppingListStateResponse')

export type TShoppingListCausedBy = z.infer<typeof CausedBySchema>
export type TShoppingListEventPayload = z.infer<typeof ShoppingListEventPayloadSchema>
export type TShoppingStatePayload = z.infer<typeof ShoppingStatePayloadSchema>
