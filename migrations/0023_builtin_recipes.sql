-- Add 'builtin' source for Veckly-curated public recipe library
ALTER TYPE "public"."recipe_source" ADD VALUE 'builtin';

-- Allow NULL household_id for public/builtin recipes (no household owns them)
ALTER TABLE "recipes" ALTER COLUMN "household_id" DROP NOT NULL;
