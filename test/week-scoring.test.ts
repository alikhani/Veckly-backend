import { describe, expect, it } from 'vitest'
import {
  createWeekContext,
  deriveAssignmentReason,
  detectFatiguedMeals,
  evaluateAssignmentConfidence,
  extractRecentMealIds,
  rankCandidates,
  scoreFamilyRecipe,
  scoreFatigue,
  scoreMeal,
  scoreMealFromFeedback,
  scoreRecency,
  scoreWeekConstraints,
  updateWeekContext,
  type TFeedbackState,
  type TReasonContext,
  type TScoringContext,
  type TScoringRecipe,
} from '../src/week-scoring.js'

function recipe(overrides: Partial<TScoringRecipe> & { id: string }): TScoringRecipe {
  return {
    title: overrides.id,
    tags: [],
    ingredients: null,
    cuisine: null,
    proteinSource: null,
    mealWeight: null,
    householdId: null,
    ...overrides,
  }
}

function baseContext(overrides: Partial<TScoringContext> = {}): TScoringContext {
  return {
    householdId: 'household-1',
    feedback: {},
    allRecipes: [],
    weekCtx: createWeekContext(),
    ...overrides,
  }
}

describe('scoreMealFromFeedback', () => {
  it('scores an explicitly liked recipe +8', () => {
    const pasta = recipe({ id: 'pasta' })
    const feedback: TFeedbackState = { pasta: { vote: 'up' } }

    expect(scoreMealFromFeedback(pasta, feedback, [pasta])).toBe(8)
  })

  it('scores an explicitly disliked recipe -12', () => {
    const pasta = recipe({ id: 'pasta' })
    const feedback: TFeedbackState = { pasta: { vote: 'down' } }

    expect(scoreMealFromFeedback(pasta, feedback, [pasta])).toBe(-12)
  })

  it('adds the signal score on top of the explicit vote', () => {
    const pasta = recipe({ id: 'pasta' })
    const feedback: TFeedbackState = { pasta: { vote: 'up', signal: 'family-approved' } }

    expect(scoreMealFromFeedback(pasta, feedback, [pasta])).toBe(8 + 3)
  })

  it('gives an un-rated recipe spillover credit from a liked recipe sharing tags', () => {
    const tacos = recipe({ id: 'tacos', tags: ['quick', 'child-friendly'] })
    const pasta = recipe({ id: 'pasta', tags: ['quick'] })
    const feedback: TFeedbackState = { tacos: { vote: 'up' } }

    // 1 shared tag ("quick"): min(3,1) * 1.25
    expect(scoreMealFromFeedback(pasta, feedback, [tacos, pasta])).toBe(1.25)
  })

  it('gives an un-rated recipe a penalty from a disliked recipe sharing tags', () => {
    const tacos = recipe({ id: 'tacos', tags: ['quick'] })
    const pasta = recipe({ id: 'pasta', tags: ['quick'] })
    const feedback: TFeedbackState = { tacos: { vote: 'down' } }

    // 1 shared tag: min(2,1) * 1.1
    expect(scoreMealFromFeedback(pasta, feedback, [tacos, pasta])).toBe(-1.1)
  })

  it('ignores votes on recipes that share no tags', () => {
    const tacos = recipe({ id: 'tacos', tags: ['spicy'] })
    const pasta = recipe({ id: 'pasta', tags: ['quick'] })
    const feedback: TFeedbackState = { tacos: { vote: 'up' } }

    expect(scoreMealFromFeedback(pasta, feedback, [tacos, pasta])).toBe(0)
  })
})

describe('scoreRecency', () => {
  it('penalizes a recipe cooked last week more than one cooked two weeks ago', () => {
    const meal = recipe({ id: 'a' })
    expect(scoreRecency(meal, { lastWeek: ['a'], twoWeeksAgo: [] })).toBe(-8)
    expect(scoreRecency(meal, { lastWeek: [], twoWeeksAgo: ['a'] })).toBe(-4)
  })

  it('is neutral for a recipe not cooked in either recent week', () => {
    const meal = recipe({ id: 'a' })
    expect(scoreRecency(meal, { lastWeek: ['b'], twoWeeksAgo: ['c'] })).toBe(0)
  })

  it('is neutral when no recency context is available', () => {
    const meal = recipe({ id: 'a' })
    expect(scoreRecency(meal, undefined)).toBe(0)
  })
})

describe('scoreFatigue', () => {
  it('penalizes a fatigued recipe', () => {
    expect(scoreFatigue(recipe({ id: 'a' }), ['a'])).toBe(-10)
  })

  it('is neutral for a recipe not on the fatigued list', () => {
    expect(scoreFatigue(recipe({ id: 'a' }), ['b'])).toBe(0)
  })
})

describe('scoreFamilyRecipe', () => {
  it('boosts a recipe owned by the requesting household', () => {
    const meal = recipe({ id: 'a', householdId: 'household-1' })
    expect(scoreFamilyRecipe(meal, 'household-1')).toBe(12)
  })

  it('does not boost a built-in or another household\'s recipe', () => {
    expect(scoreFamilyRecipe(recipe({ id: 'a', householdId: null }), 'household-1')).toBe(0)
    expect(scoreFamilyRecipe(recipe({ id: 'a', householdId: 'household-2' }), 'household-1')).toBe(0)
  })
})

describe('week constraint scoring', () => {
  it('does not penalize the first two occurrences of a cuisine', () => {
    const ctx = createWeekContext()
    const italian1 = recipe({ id: 'a', cuisine: 'italian' })
    const italian2 = recipe({ id: 'b', cuisine: 'italian' })

    expect(scoreWeekConstraints(italian1, ctx)).toBe(0)
    updateWeekContext(ctx, italian1)
    expect(scoreWeekConstraints(italian2, ctx)).toBe(0)
  })

  it('penalizes the third occurrence of the same cuisine in the week', () => {
    const ctx = createWeekContext()
    updateWeekContext(ctx, recipe({ id: 'a', cuisine: 'italian' }))
    updateWeekContext(ctx, recipe({ id: 'b', cuisine: 'italian' }))
    const italian3 = recipe({ id: 'c', cuisine: 'italian' })

    expect(scoreWeekConstraints(italian3, ctx)).toBe(-6)
  })

  it('penalizes the third occurrence of the same protein source', () => {
    const ctx = createWeekContext()
    updateWeekContext(ctx, recipe({ id: 'a', proteinSource: 'chicken' }))
    updateWeekContext(ctx, recipe({ id: 'b', proteinSource: 'chicken' }))
    const chicken3 = recipe({ id: 'c', proteinSource: 'chicken' })

    expect(scoreWeekConstraints(chicken3, ctx)).toBe(-5)
  })

  it('penalizes a hearty meal placed right after another hearty meal', () => {
    const ctx = createWeekContext()
    updateWeekContext(ctx, recipe({ id: 'a', mealWeight: 'hearty' }))
    const heartyNext = recipe({ id: 'b', mealWeight: 'hearty' })
    const lightNext = recipe({ id: 'c', mealWeight: 'light' })

    expect(scoreWeekConstraints(heartyNext, ctx)).toBe(-4)
    expect(scoreWeekConstraints(lightNext, ctx)).toBe(0)
  })
})

describe('rankCandidates', () => {
  it('ranks the highest-scoring recipe first', () => {
    const liked = recipe({ id: 'liked' })
    const neutral = recipe({ id: 'neutral' })
    const disliked = recipe({ id: 'disliked' })
    const feedback: TFeedbackState = { liked: { vote: 'up' }, disliked: { vote: 'down' } }
    const ctx = baseContext({ feedback, allRecipes: [liked, neutral, disliked] })

    const ranked = rankCandidates([disliked, neutral, liked], ctx)

    expect(ranked.map((r) => r.id)).toEqual(['liked', 'neutral', 'disliked'])
  })

  it('breaks equal-score ties deterministically by recipe id, never randomly', () => {
    const a = recipe({ id: 'aaa' })
    const b = recipe({ id: 'bbb' })
    const ctx = baseContext({ allRecipes: [a, b] })

    const first = rankCandidates([b, a], ctx).map((r) => r.id)
    const second = rankCandidates([b, a], ctx).map((r) => r.id)

    expect(first).toEqual(['aaa', 'bbb'])
    expect(second).toEqual(['aaa', 'bbb'])
  })
})

describe('scoreMeal', () => {
  it('combines feedback, recency, fatigue, week-constraints, and family-recipe boost', () => {
    const meal = recipe({ id: 'a', householdId: 'household-1', cuisine: 'italian' })
    const ctx = baseContext({
      householdId: 'household-1',
      feedback: { a: { vote: 'up' } },
      allRecipes: [meal],
      recentMealIds: { lastWeek: ['a'], twoWeeksAgo: [] },
      fatiguedMealIds: ['a'],
    })

    // +12 family recipe, +8 liked, -8 recency (last week), -10 fatigue, +0 week-constraints (first cuisine placement)
    expect(scoreMeal(meal, ctx)).toBe(12 + 8 - 8 - 10)
  })
})

describe('extractRecentMealIds', () => {
  it('buckets meals into last-week and two-weeks-ago by date distance', () => {
    const result = extractRecentMealIds(
      [
        { weekStartDate: '2026-06-01', mealIds: ['a', 'b'] },
        { weekStartDate: '2026-05-25', mealIds: ['c'] },
        { weekStartDate: '2026-05-18', mealIds: ['d'] },
      ],
      '2026-06-08',
    )

    expect(result.lastWeek).toEqual(['a', 'b'])
    expect(result.twoWeeksAgo).toEqual(['c'])
  })

  it('ignores records more than two weeks back', () => {
    const result = extractRecentMealIds([{ weekStartDate: '2026-05-18', mealIds: ['d'] }], '2026-06-08')

    expect(result.lastWeek).toEqual([])
    expect(result.twoWeeksAgo).toEqual([])
  })
})

describe('detectFatiguedMeals', () => {
  it('flags a meal that ran 3+ consecutive weeks and was then dropped, for its first 2 weeks off', () => {
    const records = [
      { weekStartDate: '2026-05-04', mealIds: ['a'] },
      { weekStartDate: '2026-05-11', mealIds: ['a'] },
      { weekStartDate: '2026-05-18', mealIds: ['a'] },
      { weekStartDate: '2026-05-25', mealIds: [] },
    ]

    expect(detectFatiguedMeals(records)).toEqual(['a'])
  })

  it('does not flag a meal cooked fewer than 3 consecutive weeks', () => {
    const records = [
      { weekStartDate: '2026-05-04', mealIds: ['a'] },
      { weekStartDate: '2026-05-11', mealIds: ['a'] },
      { weekStartDate: '2026-05-18', mealIds: [] },
      { weekStartDate: '2026-05-25', mealIds: [] },
    ]

    expect(detectFatiguedMeals(records)).toEqual([])
  })

  it('requires at least 4 weeks of history before flagging anything', () => {
    const records = [
      { weekStartDate: '2026-05-04', mealIds: ['a'] },
      { weekStartDate: '2026-05-11', mealIds: ['a'] },
      { weekStartDate: '2026-05-18', mealIds: ['a'] },
    ]

    expect(detectFatiguedMeals(records)).toEqual([])
  })
})

function baseReasonContext(overrides: Partial<TReasonContext> = {}): TReasonContext {
  return { householdId: 'household-1', feedback: {}, allRecipes: [], ...overrides }
}

describe('deriveAssignmentReason', () => {
  it('picks liked-before first, even when the recipe is also the household\'s own', () => {
    const pasta = recipe({ id: 'pasta', householdId: 'household-1' })
    const ctx = baseReasonContext({ feedback: { pasta: { vote: 'up' } } })

    expect(deriveAssignmentReason(pasta, ctx)).toBe('liked-before')
  })

  it('picks family-recipe for the household\'s own recipe with no feedback', () => {
    const pasta = recipe({ id: 'pasta', householdId: 'household-1' })
    const ctx = baseReasonContext()

    expect(deriveAssignmentReason(pasta, ctx)).toBe('family-recipe')
  })

  it('picks back-after-break for a fatigued meal that still won its slot', () => {
    const pasta = recipe({ id: 'pasta', householdId: null })
    const ctx = baseReasonContext({ fatiguedMealIds: ['pasta'] })

    expect(deriveAssignmentReason(pasta, ctx)).toBe('back-after-break')
  })

  it('picks based-on-feedback for positive tag spillover with no direct vote', () => {
    const pasta = recipe({ id: 'pasta', householdId: null, tags: ['quick'] })
    const liked = recipe({ id: 'liked', tags: ['quick'] })
    const ctx = baseReasonContext({ feedback: { liked: { vote: 'up' } }, allRecipes: [pasta, liked] })

    expect(deriveAssignmentReason(pasta, ctx)).toBe('based-on-feedback')
  })

  it('picks new-for-variety for a recipe absent from recent history', () => {
    const pasta = recipe({ id: 'pasta', householdId: null })
    const ctx = baseReasonContext({ everCookedRecipeIds: new Set(['other']) })

    expect(deriveAssignmentReason(pasta, ctx)).toBe('new-for-variety')
  })

  it('returns undefined when no signal applies', () => {
    const pasta = recipe({ id: 'pasta', householdId: null })
    const ctx = baseReasonContext({ everCookedRecipeIds: new Set(['pasta']) })

    expect(deriveAssignmentReason(pasta, ctx)).toBeUndefined()
  })
})

describe('evaluateAssignmentConfidence', () => {
  it('flags low confidence for a hearty meal placed right after another hearty meal', () => {
    const ctx = createWeekContext()
    ctx.placedWeights.push('hearty')
    const pasta = recipe({ id: 'pasta', mealWeight: 'hearty' })

    expect(evaluateAssignmentConfidence(pasta, ctx)).toBe('low')
  })

  it('flags low confidence for a 3rd repeat of the same cuisine', () => {
    const ctx = createWeekContext()
    ctx.placedCuisines.italian = 2
    const pasta = recipe({ id: 'pasta', cuisine: 'italian' })

    expect(evaluateAssignmentConfidence(pasta, ctx)).toBe('low')
  })

  it('flags low confidence for a 3rd repeat of the same protein source', () => {
    const ctx = createWeekContext()
    ctx.placedProteins.chicken = 2
    const pasta = recipe({ id: 'pasta', proteinSource: 'chicken' })

    expect(evaluateAssignmentConfidence(pasta, ctx)).toBe('low')
  })

  it('is ok when nothing about the pick is a compromise', () => {
    const ctx = createWeekContext()
    const pasta = recipe({ id: 'pasta', cuisine: 'italian', proteinSource: 'chicken', mealWeight: 'light' })

    expect(evaluateAssignmentConfidence(pasta, ctx)).toBe('ok')
  })
})
