-- Custom SQL migration file, put your code below! --

-- "meal_type" is a bare `text not null` column even though the Zod schema at
-- the route layer (`z.enum(['lunch', 'dinner'])` in src/prep-batches.ts)
-- already restricts it to two values. Add the matching CHECK constraint so
-- the database enforces the same invariant the route does, independent of
-- the application code path (internal routes parse with the same schema
-- today, but a future direct-DB write or a schema drift in the route layer
-- should not be able to write an invalid meal_type).
alter table "household_prep_batch_assignments"
  add constraint "household_prep_batch_assignments_meal_type_check"
  check ("meal_type" in ('lunch', 'dinner'));

-- No FK added for "custom_recipe_id" here: there is no "custom_recipes" table
-- in this schema (or in MealPlanner's) to reference yet. It's currently a
-- forward-looking column for the not-yet-built custom-recipe feature
-- described in MealPlanner/docs/architecture/custom-recipes-schema-and-api-
-- spec-2026-04.md (Phase 1 foundation for ADR 0031) — until that table
-- exists, there's nothing to constrain against. Add the FK
-- (`references custom_recipes(id) on delete set null`, matching the existing
-- `recipe_id` FK pattern) in the same migration that introduces that table.
