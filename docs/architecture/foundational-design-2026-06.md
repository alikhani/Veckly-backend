# Foundational design decisions — Veckly backend (v2, clean-slate)

Status: agreed direction, not yet implemented. Captured 2026-06-08 from an architecture
discussion that deliberately set MealPlanner's constraints aside and asked: "knowing what we
know now, how would we build this domain from scratch?"

This document is the reference point for the first implementation work. Read it before writing
the first module — it explains *why*, not just *what*, so the reasoning survives even where the
specific shapes below evolve.

## Context: why a clean-slate look, and what grounds it

MealPlanner (v0.0.1 — "getting the thinking down on paper") is a mature, working product in
closed beta. It is **not being thrown away** — it remains the canonical source of product and
domain knowledge (`MealPlanner/docs/`), and the backend extraction should preserve its observable
behavior. But several of its hardest-won lessons were learned the expensive way — retrofitted
after the fact and documented in its own ADRs. A clean-slate design gets to bake those lessons in
as first-class decisions instead of repairs. Each decision below names the MealPlanner evidence
that motivates it.

## 1. Backend stack

- **Hono** + `@hono/zod-openapi` — modern, fast, runs anywhere (Node/Bun/Workers/Vercel).
  The OpenAPI-from-Zod story is the deciding factor: the same Zod schemas that validate requests
  produce the spec that feeds Apple's `swift-openapi-generator`, generating a typed Swift client
  for Veckly-ios automatically. Treat the spec as a real contract, not an afterthought.
- **Drizzle + Postgres (Supabase)** — superseded 2026-06-08: originally "keep Kysely (unchanged
  from MealPlanner)", revised to Drizzle once the founder noted they already use it in another
  active project (Coach-ios). Two reasons tipped it: (1) cross-project consistency compounds —
  one query layer across a portfolio means less context-switching for both founder and agents;
  (2) the "continuity with MealPlanner" argument for Kysely is weaker than it looks, because this
  is a deliberate schema *redesign* (event tables, projections, RLS), not a lift-and-shift — so
  Kysely's main advantage (proven queries transfer) doesn't actually apply. Drizzle's schema-as-
  code + generated migrations also fit a from-scratch schema build well. See [[infra-vendor-decisions]]
  for the fuller reasoning trail.
- **Supabase Auth** — superseded 2026-06-08: originally "Better Auth (carries existing investment
  forward)", revised once the founder confirmed the strategy is **native-iOS-first with Sign in
  with Apple as the primary flow**. Better Auth is fundamentally web-session/cookie-oriented; its
  native/idToken support is real but a side path, not its center of gravity. Supabase Auth is
  built for exactly this shape (`signInWithIdToken`, official Swift SDK), and — critically —
  pairs naturally with the RLS-as-security-boundary decision in §3: `auth.uid()` is a first-class
  RLS primitive in Supabase, whereas Better Auth would require bridging its own session/user model
  into something RLS can check. One less integration surface, and the pieces reinforce each other.
- **Hosting**: start on **Vercel** (already known — minimizes new tooling while validating the
  split). Move to Railway/Fly.io only when a *concrete* limit is hit (execution timeouts on AI
  calls, background-job needs, real international-latency complaints) — not a hypothetical one.

Full reasoning: `/Users/nima/Documents/dev/Veckly/CLAUDE.md`.

## 2. The week plan: event-sourced, with projection-as-read-path

### The model

A week plan is not a mutable row — it's the fold of everything that happened to it. Events are
small, typed, and append-only:

```ts
type TWeekPlanEvent = {
  id: string                  // uuid (v7 — see §4)
  householdId: string
  weekStartDate: string       // natural key component — a calendar date, not a surrogate id
  sequenceNumber: number      // monotonic per-aggregate order — must be comparable, hence integer
  occurredAt: string
  causedBy:
    | { source: 'user'; userId: string }
    | { source: 'algorithm'; algorithmVersion: string; triggeredByUserId: string }
    | { source: 'system'; reason: 'monday-rollover' | 'trial-expiry' | string }
} & TWeekPlanEventPayload

// Payload union (representative — extend as needed):
// WeekStarted, WeekFinalized
// PlanningRequestUpdated, DayActivated, DayDeactivated, DaySettingsChanged
// MealAssigned (carries reasonTags + confidence + generationBatchId — explanation IS provenance)
// MealReplaced, MealLocked, MealUnlocked, MealMoved, DaySkipped, DayUnskipped, ServingsChanged
// PlanGenerated (batch event — the algorithm's "opinion", carries its own reasoning per assignment)
// MealAddedToPool, MealRemovedFromPool, PoolCleared
```

### The pattern that makes it fast: projection is the hot path, the log sits beside it

**This is the one rule that determines whether this design is fast or slow.** Every write appends
an event *and* updates a materialized projection table, in the same transaction:

```sql
begin;
  insert into week_plan_events (...) values (...);
  update week_plan_projections set state = state || jsonb_build_object(...) 
    where household_id = $1 and week_start_date = $2;
commit;
```

Reads — including the "what's for dinner Tuesday" lookup that the product principles say must be
instant ("weekday speed: one glance, no navigation") — are a single primary-key lookup against the
projection table. **Never replay the event log on the read path.** The log is the audit trail and
the source of "why" — read only when a user actually asks why, which is rare and not
latency-sensitive. Add periodic snapshots only if the projection-update cost itself becomes
measurable (it won't, at this product's realistic scale — see §5).

### What this buys, concretely (vs. what MealPlanner had to build separately)

| Need | MealPlanner had to build | Falls out of this model |
|---|---|---|
| Explainability (a stated product principle) | a parallel "reason" field kept in sync with state | the event log *is* the explanation — provenance, not a derived summary |
| Week history | a separate table + finalize flow + repository | a finished week is a log that stopped growing |
| Undo | none today, or a bespoke stack | append a compensating event |
| Collaboration / sync | OCC + `expectedUpdatedAt` + 409s + a version-cache factory (ADR 0040, journey W1-2/W1-3/W1-4) | merge ordered streams — ordering is a much narrower problem than state-merge |

### Honest costs

- Reads need a maintained projection (one extra moving part, but a well-understood one — CQRS).
- Event payload shapes need a versioning discipline over time.
- The mental model ("what sequence of events produced this state") is a real shift from "what
  does this row say" — worth being deliberate about as the team gets used to it.

**Recommended way to de-risk it**: build *only the week-plan aggregate* this way; keep
recipes/households/billing as conventional CRUD. If it earns its keep here (and the
explainability + collaboration payoff strongly suggests it will), extending it is easy. If not,
the "loss" is scoped to one module — not an entire architecture.

## 3. Households: membership as a database invariant, one shared-state mechanism

### Model

```ts
type THousehold = { id: string; name: string; defaults: { adults; children; priorities; avoidIngredients; defaultDays } }
type THouseholdMembership = { householdId: string; userId: string; role: 'owner' | 'member'; status: 'active' | 'removed'; joinedAt: string }
type THouseholdInvite = { id: string; householdId: string; token: string; recipientEmail: string | null; status: 'pending' | 'accepted' | 'revoked' | 'expired'; acceptedBy: {...} | null; expiresAt: string }
```

### Three deliberate departures from the MealPlanner shape

1. **Row-Level Security as the actual security boundary**, not a route-layer convention.
   MealPlanner's permission pattern (authenticate → authorize → gate → repository) requires every
   route author to remember to check membership; repositories trust the caller. Getting it wrong
   means a cross-household leak, and the only defense today is code review (an entire audit
   project — W2-3, "33 endpoints verified compliant"). RLS policies referencing
   `household_memberships` make this a database-enforced invariant: a forgotten check can't leak
   data, because the database physically won't return rows the caller can't see.

2. **One shared-state mechanism, not four.** MealPlanner ended up with four parallel
   household-scoped resources (active-plan, active-week, shopping-state, profile), each with its
   own repository and sync protocol — and had to extract a shared factory
   (`household-versioned-resource.ts`) afterward to de-duplicate the conflict-handling logic.
   Generalize the event-stream idea from §2: **all mutable household state is a named event
   stream** (`week-plan:<date>`, `shopping-list:<date>`, `household-profile`). Build the
   storage/sync/realtime machinery once, not four times plus a cleanup pass.

3. **Active household is part of the user's session model**, not a cache to invalidate
   (`primaryHouseholdIdCache` was a symptom of this not being modeled explicitly).

### Invites as a state machine

`status: pending → accepted | revoked | expired` makes transitions explicit, testable in
isolation, and impossible to half-implement (e.g. "can an already-revoked invite be accepted?"
becomes a one-line rule in a transition table, not logic scattered across endpoints).

## 4. Recipes: one entity, provenance as a typed union

### The key move: `origin` as a discriminated union replaces five separate concerns

MealPlanner already lived through this exact redesign — "Initiative 4: Recipe Unification"
(sub-fases A–C) replaced a `custom_recipes` table with JSON columns and a *separate, hardcoded*
150-recipe library spread across six cuisine source files, normalizing into one `recipes` table
plus `recipe_ingredients`/`recipe_steps`/`user_saved_recipes`/fork-lineage columns/translation
tables. **Building it this way from day one means starting where they painstakingly arrived, not
where they started.**

```ts
type TRecipe = {
  id: string; title: string; description: string
  servings: number; prepTimeMinutes: number
  cuisine, proteinSource, mealWeight, tags, language: ...
  visibility: 'private' | 'household' | 'community-pending' | 'public'   // state machine, not a boolean
  owner: { kind: 'user'; userId } | { kind: 'household'; householdId } | { kind: 'system' }
  origin: TRecipeOrigin
}

type TRecipeOrigin =
  | { kind: 'curated' }                                                       // replaces "built-in" as a special case
  | { kind: 'manual'; createdBy: string }
  | { kind: 'ai-generated'; model: string; sourceTitle: string }              // replaces the separate fill-in pipeline
  | { kind: 'imported'; sourceUrl: string; method: 'structured-data' | 'ai-extraction' }
  | { kind: 'forked'; fromRecipeId: string; rootRecipeId: string }            // lineage as a graph edge
  | { kind: 'translated'; fromRecipeId: string; targetLanguage: string }      // a translation IS a derived variant — same mechanism as a fork
```

What this collapses: built-in vs. custom, AI-generated vs. manual, forked lineage
(`forked_from_id`/`root_recipe_id`), import attribution (`source_url`), and the translation layer
— five things MealPlanner modeled with five different mechanisms — become one switch statement and
one walkable graph. "Family recipes" need no special table: they're just
`owner.kind === 'household' && origin.kind === 'forked'`.

### Connection to the week-plan event log

`MealAssigned` references a recipe id. If a recipe is edited after appearing in a historical
week, "why was this chosen" should reflect the recipe *as it was* at assignment time. Don't build
full recipe versioning for this — simpler and sufficient: have `MealAssigned` carry a copy of the
fields that drove the choice (`reasonTags`, `cuisine`, `mealWeight` at assignment time). Revisit
only if concrete evidence says otherwise.

## 5. Identifier strategy — different jobs, different types

A rule, not a convention to memorize per-table:

> Ask "what is this value's job", not "what's the default ID type":
> - Points at a row, arbitrarily? → **UUID, prefer v7** (time-ordered → better Postgres index
>   locality than v4, while keeping global uniqueness and client-side generability — which matters
>   for the optimistic-write pattern in §2)
> - Is the value itself the meaningful information (a date, a language code, a status)? →
>   **its natural domain type** — wrapping `week_start_date` in a UUID would prevent "all weeks
>   starting in June" without a join back to a lookup
> - Must be ordered/compared (`sequence_number`)? → **integer** — UUIDs (certainly v4) aren't
>   meaningfully comparable
> - Is it a shareable/revocable *capability* rather than an internal reference (`invite.token`)?
>   → **its own high-entropy string, never the same column as `id`** — conflating "internal
>   identity" with "external capability" makes rotation/revocation/click-tracking awkward later,
>   for no benefit now

## 6. Performance & scale — the honest assessment

Done per §2's projection-as-read-path rule, this design costs **nothing extra on reads** and
**one additional `INSERT`** on writes — negligible next to what MealPlanner already pays for
sync/conflict machinery today.

**Reality check on "scale"**: this is a low-frequency, high-value product (one real session per
household per week). Even at 200k households, that's ~200k active projection rows and a few
million events/year — trivial for Postgres at any realistic scale. The architecture is not the
limiting factor.

**What actually determines "feels fast"** (mostly *not* architecture):
1. Cold starts (MealPlanner had to fix this explicitly — 7-12s → near-instant, 2026-06-06) — a
   hosting/runtime concern.
2. Chatty client-server protocols — shape API responses around what a screen needs, not around
   tables.
3. Optimistic UI — apply events locally immediately, sync in background (MealPlanner already does
   this well via `useSyncExternalStore`; the pattern carries over directly to event application).
4. AI call latency — the real bottleneck for AI-backed flows; solved with caching, background
   processing, and good loading states, not data-model choices.
5. Indexing the right things as plain columns (`origin_kind`, `visibility`) rather than leaving
   discriminators buried in JSONB; caching the recipe catalog aggressively at the edge (it's
   read-heavy, write-rare — ideal for CDN caching).

## 7. What to build first vs. let grow organically

Apply "smallest increment first" to the *architecture itself*, not just to features:

**Worth the investment from day one** (cheap now, brutally expensive to retrofit):
- RLS on household-scoped tables
- The week-plan event model (it's the product's core, and explainability is already a stated
  principle — building it right once beats building the snapshot model and migrating later)

**Let grow organically** (start simple, replace only when it actually hurts):
- Realtime sync — start with polling/simple invalidation; move to Postgres change-feeds /
  Supabase Realtime once household collaboration is real and the simple version visibly strains
- AI gateway abstraction — start with direct, well-isolated Claude calls per feature; consolidate
  into a shared gateway once you're maintaining 3+ near-identical integration paths (the same
  signal MealPlanner eventually hit)
- Background job queue — start with HTTP-triggered routes + Vercel Cron; reach for a real queue
  only when a job genuinely doesn't fit in an HTTP request lifecycle

## Open questions for implementation time

- Exact shape of the projection table(s) — one JSONB blob per week, or normalized columns for the
  fields that get queried/filtered directly?
- Snapshot cadence for the event log, if/when it's needed (likely: not needed at this scale —
  revisit with evidence, not speculation)
- Where the line is between "household event stream" and "user-scoped" data (saved plans, custom
  recipe authorship, feedback) — sketched in §3 but not fully drawn
