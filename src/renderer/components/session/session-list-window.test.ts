import { describe, expect, it } from 'vitest'
import {
  displayRangeToSessionRange,
  getPageStartsForRange,
  getPrefetchRange,
  getSessionListDisplayCount,
  getSessionListSlot,
  shouldEvictColdPage,
} from './session-list-window'

describe('session list display mapping', () => {
  it('maps a list without pinned sessions directly', () => {
    expect(getSessionListDisplayCount(3, 0)).toBe(3)
    expect(getSessionListSlot(2, 3, 0)).toEqual({ type: 'session', sessionIndex: 2 })
  })

  it('accounts for pinned and chat section rows', () => {
    expect(getSessionListDisplayCount(5, 2)).toBe(7)
    expect(getSessionListSlot(0, 5, 2)).toMatchObject({ type: 'section', label: 'Pinned' })
    expect(getSessionListSlot(2, 5, 2)).toEqual({ type: 'session', sessionIndex: 1 })
    expect(getSessionListSlot(3, 5, 2)).toMatchObject({ type: 'section', label: 'Chats' })
    expect(getSessionListSlot(4, 5, 2)).toEqual({ type: 'session', sessionIndex: 2 })
    expect(displayRangeToSessionRange(0, 4, 5, 2)).toEqual({ start: 0, end: 2 })
  })
})

describe('session list window planning', () => {
  it('prefetches farther in the direction of fast scrolling', () => {
    expect(getPrefetchRange({ start: 500, end: 520 }, 2_000, 1, 80)).toEqual({ start: 450, end: 920 })
    expect(getPrefetchRange({ start: 500, end: 520 }, 2_000, -1, 80)).toEqual({ start: 100, end: 570 })
  })

  it('returns page-aligned offsets', () => {
    expect(getPageStartsForRange({ start: 51, end: 151 })).toEqual([50, 100, 150])
  })

  it('keeps a cold page while moving quickly toward it', () => {
    expect(
      shouldEvictColdPage({
        pageStart: 500,
        pageSize: 50,
        visible: { start: 0, end: 20 },
        direction: 1,
        speedItemsPerSecond: 30,
        loadedAt: 0,
        now: 60_000,
      })
    ).toBe(false)
  })

  it('expires speculative pages before pages that were actually viewed', () => {
    const base = {
      pageStart: 500,
      pageSize: 50,
      visible: { start: 0, end: 20 },
      direction: 0 as const,
      speedItemsPerSecond: 0,
      loadedAt: 0,
    }
    expect(shouldEvictColdPage({ ...base, now: 10_000 })).toBe(true)
    expect(shouldEvictColdPage({ ...base, lastVisibleAt: 1_000, now: 20_000 })).toBe(false)
    expect(shouldEvictColdPage({ ...base, lastVisibleAt: 1_000, now: 31_000 })).toBe(true)
  })
})
