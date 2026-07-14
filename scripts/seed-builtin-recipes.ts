/**
 * Seeds ~150 Veckly-curated recipes into the public recipe library.
 * Safe to run multiple times — exits early if builtin recipes already exist.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/seed-builtin-recipes.ts
 */

import postgres from 'postgres'
import { randomUUID } from 'crypto'

// ---- Inline type (mirrors TMeal from MealPlanner) --------------------------

type MealIngredient = { name: string; amount: number; unit: string; category: string }
type Meal = {
  id: string
  title: string
  description: string
  prepTimeMinutes: number
  servings: number
  tags: string[]
  cuisine?: string
  proteinSource?: string
  mealWeight?: string
  ingredients: MealIngredient[]
  steps?: string[]
}

// ---- Load meals from MealPlanner -------------------------------------------
// Resolved at runtime via relative path — this script is intentionally
// cross-repo and only meant to be run from a developer machine with both repos
// checked out side by side.

const mealPlanner = new URL('../../MealPlanner/src/data/meals', import.meta.url).pathname

async function loadMeals(): Promise<Meal[]> {
  const [
    { italianMeals },
    { asianMeals },
    { nordicMeals },
    { mexicanMeals },
    { middleEasternMeals },
    { comfortMeals },
  ] = await Promise.all([
    import(`${mealPlanner}/italian.ts`),
    import(`${mealPlanner}/asian.ts`),
    import(`${mealPlanner}/nordic.ts`),
    import(`${mealPlanner}/mexican.ts`),
    import(`${mealPlanner}/middle-eastern.ts`),
    import(`${mealPlanner}/comfort.ts`),
  ])
  return [...italianMeals, ...asianMeals, ...nordicMeals, ...mexicanMeals, ...middleEasternMeals, ...comfortMeals]
}

// ---- Transform MealPlanner format → Veckly recipe format -------------------

function toIngredient(ing: MealIngredient) {
  return { item: ing.name, amount: String(ing.amount), unit: ing.unit, category: ing.category }
}

function toStep(text: string) {
  return { text }
}

// ---- Main ------------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const sql = postgres(databaseUrl)

async function run() {
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM recipes WHERE source = 'builtin'`
  if (count > 0) {
    console.log(`Already seeded (${count} builtin recipes found). Nothing to do.`)
    await sql.end()
    return
  }

  const meals = await loadMeals()
  console.log(`Seeding ${meals.length} builtin recipes…`)

  const now = new Date()

  const rows = meals.map((meal) => ({
    id: randomUUID(),
    household_id: null,
    title: meal.title,
    description: meal.description ?? '',
    servings: meal.servings,
    ingredients: meal.ingredients.map(toIngredient),
    steps: (meal.steps ?? []).map(toStep),
    tags: meal.tags,
    prep_time_minutes: meal.prepTimeMinutes,
    cook_time_minutes: null,
    cuisine: meal.cuisine ?? null,
    protein_source: meal.proteinSource ?? null,
    meal_weight: meal.mealWeight ?? null,
    source_url: null,
    source: 'builtin' as const,
    is_public: true,
    is_archived: false,
    created_by: '00000000-0000-0000-0000-000000000000',
    created_at: now,
    updated_at: now,
  }))

  for (const row of rows) {
    await sql`
      INSERT INTO recipes (
        id, household_id, title, description, servings,
        ingredients, steps, tags,
        prep_time_minutes, cook_time_minutes,
        cuisine, protein_source, meal_weight, source_url,
        source, is_public, is_archived, created_by,
        created_at, updated_at
      ) VALUES (
        ${row.id}, ${row.household_id}, ${row.title}, ${row.description}, ${row.servings},
        ${sql.json(row.ingredients)}, ${sql.json(row.steps)}, ${sql.json(row.tags)},
        ${row.prep_time_minutes}, ${row.cook_time_minutes},
        ${row.cuisine}, ${row.protein_source}, ${row.meal_weight}, ${row.source_url},
        ${row.source}, ${row.is_public}, ${row.is_archived}, ${row.created_by},
        ${row.created_at}, ${row.updated_at}
      )
      ON CONFLICT DO NOTHING
    `
  }

  console.log(`Done — ${rows.length} recipes inserted.`)
  await sql.end()
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
