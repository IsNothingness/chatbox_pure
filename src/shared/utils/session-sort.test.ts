import { describe, expect, it } from 'vitest'
import { areSessionsInSamePinGroup, getSortOrderImmediatelyAbove } from './session-sort'

describe('areSessionsInSamePinGroup', () => {
  it('treats false and undefined as the same unpinned group', () => {
    expect(areSessionsInSamePinGroup({ starred: false }, {})).toBe(true)
  })

  it('keeps pinned and unpinned sessions in different groups', () => {
    expect(areSessionsInSamePinGroup({ starred: true }, { starred: false })).toBe(false)
    expect(areSessionsInSamePinGroup({ starred: true }, {})).toBe(false)
  })

  it('returns false when either session is missing', () => {
    expect(areSessionsInSamePinGroup(undefined, {})).toBe(false)
    expect(areSessionsInSamePinGroup({}, undefined)).toBe(false)
  })
})

describe('getSortOrderImmediatelyAbove', () => {
  it('places a copy between its source and the preceding item in the same group', () => {
    const sessions = [
      { id: 'before', starred: false, sortOrder: 300 },
      { id: 'source', starred: false, sortOrder: 200 },
      { id: 'after', starred: false, sortOrder: 100 },
    ]
    expect(getSortOrderImmediatelyAbove(sessions, 'source')).toBe(250)
  })

  it('places a copy above the first item without crossing pin groups', () => {
    const sessions = [
      { id: 'pinned', starred: true, sortOrder: 50 },
      { id: 'source', starred: false, sortOrder: 300 },
      { id: 'after', starred: false, sortOrder: 200 },
    ]
    expect(getSortOrderImmediatelyAbove(sessions, 'source')).toBe(1300)
  })

  it('returns null when the source metadata is unavailable', () => {
    expect(getSortOrderImmediatelyAbove([], 'missing')).toBeNull()
  })
})
