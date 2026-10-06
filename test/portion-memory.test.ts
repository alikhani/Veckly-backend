import { describe, expect, it } from 'vitest'
import { derivePortionSuggestion, type PortionEvidence } from '../src/portion-memory.js'

function evidence(
  portionOutcome: PortionEvidence['portionOutcome'],
  options: Partial<PortionEvidence> = {},
): PortionEvidence {
  return {
    status: 'cooked',
    portionOutcome,
    intentionalLeftovers: false,
    updatedAt: new Date('2026-09-01T12:00:00Z'),
    ...options,
  }
}

describe('derivePortionSuggestion', () => {
  it('does not learn from a single outcome', () => {
    expect(derivePortionSuggestion([evidence('too_little')], 4)).toBeNull()
  })

  it('suggests one more portion after repeated shortage evidence', () => {
    expect(derivePortionSuggestion([
      evidence('too_little'), evidence('too_little'), evidence('right_amount'),
    ], 4)).toEqual({ direction: 'more', suggestedServings: 5, evidenceCount: 3, matchingCount: 2 })
  })

  it('suggests one less portion after repeated unwanted surplus', () => {
    expect(derivePortionSuggestion([
      evidence('too_much'), evidence('too_much'), evidence('right_amount'),
    ], 4)).toEqual({ direction: 'less', suggestedServings: 3, evidenceCount: 3, matchingCount: 2 })
  })

  it('does not treat intentional leftovers as unwanted surplus', () => {
    expect(derivePortionSuggestion([
      evidence('too_much', { intentionalLeftovers: true }),
      evidence('too_much', { intentionalLeftovers: true }),
      evidence('right_amount'),
    ], 4)).toBeNull()
  })

  it('requires fresh evidence after the household ignores or resets learning', () => {
    const ignoredThrough = new Date('2026-09-02T00:00:00Z')
    expect(derivePortionSuggestion([
      evidence('too_little'), evidence('too_little'), evidence('too_little'),
    ], 4, ignoredThrough)).toBeNull()
  })

  it('does not suggest fewer than one portion', () => {
    expect(derivePortionSuggestion([
      evidence('too_much'), evidence('too_much'), evidence('too_much'),
    ], 1)).toBeNull()
  })

  it('lets recent outcomes replace an older household pattern', () => {
    const outcomes = [
      ...Array.from({ length: 5 }, (_, index) => evidence('too_much', {
        updatedAt: new Date(`2026-08-0${index + 1}T12:00:00Z`),
      })),
      ...Array.from({ length: 4 }, (_, index) => evidence('too_little', {
        updatedAt: new Date(`2026-09-0${index + 1}T12:00:00Z`),
      })),
    ]

    expect(derivePortionSuggestion(outcomes, 4)).toMatchObject({
      direction: 'more',
      suggestedServings: 5,
      evidenceCount: 6,
      matchingCount: 4,
    })
  })
})
