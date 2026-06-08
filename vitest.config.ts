import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    // Every DB-touching suite shares one Postgres instance via TEST_DATABASE_URL,
    // and each seeds/cleans the same `households` / `household_memberships` (and,
    // for week-plan, `week_plan_*`) tables with blanket `delete from` statements
    // in beforeEach/afterAll. Running files in parallel races those statements
    // against each other's fixtures — not a flaky timing issue but a genuine
    // shared-mutable-state conflict, so the correct fix is to not run them
    // concurrently, the same reasoning that motivated global-setup.ts.
    fileParallelism: false,
  },
})
