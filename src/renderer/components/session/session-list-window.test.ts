import { describe, expect, it } from 'vitest'
import {
  displayRangeToSessionRange,
  getPageStartsForRange,
  getPlacementPreviewAction,
  getPrefetchRange,
  getReorderEdgeScrollVelocity,
  getSessionListDisplayCount,
  getSessionListSlot,
  getSessionReorderTarget,
  getSessionReorderVisualOffset,
  isWithinSourcePlacementZone,
  moveItemInPagedCache,
  sessionIndexToDisplayIndex,
  shouldEvictColdPage,
  shouldSwitchReorderTarget,
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
    expect(sessionIndexToDisplayIndex(0, 2)).toBe(1)
    expect(sessionIndexToDisplayIndex(2, 2)).toBe(4)
  })
})

describe('session reorder groups', () => {
  it('reorders pinned sessions only inside the pinned section', () => {
    expect(getSessionReorderTarget(1, 8, 3, 'pinned')).toEqual({
      targetIndex: 0,
      crossedGroup: false,
    })
    expect(getSessionReorderTarget(3, 8, 3, 'pinned')).toEqual({
      targetIndex: 2,
      crossedGroup: false,
    })
    expect(getSessionReorderTarget(4, 8, 3, 'pinned')).toEqual({
      targetIndex: null,
      crossedGroup: true,
    })
  })

  it('reorders chats only inside the chats section', () => {
    expect(getSessionReorderTarget(4, 8, 3, 'chats')).toEqual({
      targetIndex: 3,
      crossedGroup: false,
    })
    expect(getSessionReorderTarget(7, 8, 3, 'chats')).toEqual({
      targetIndex: 5,
      crossedGroup: false,
    })
    expect(getSessionReorderTarget(3, 8, 3, 'chats')).toEqual({
      targetIndex: null,
      crossedGroup: true,
    })
  })

  it('maps an ungrouped chat list directly', () => {
    expect(getSessionReorderTarget(4, 8, 0, 'chats')).toEqual({
      targetIndex: 4,
      crossedGroup: false,
    })
  })
})

describe('session reorder placement preview', () => {
  it('clears a confirmed cyan slot when the finger leaves every placement area', () => {
    expect(
      getPlacementPreviewAction({
        currentPreviewKey: 'source:active',
        pendingCandidateKey: 'source:active',
        nextCandidateKey: null,
        listMoved: false,
      })
    ).toBe('clear')
  })

  it('clears the current cyan slot while the list is moving', () => {
    expect(
      getPlacementPreviewAction({
        currentPreviewKey: 'source:active',
        pendingCandidateKey: null,
        nextCandidateKey: '4:5:bottom',
        listMoved: true,
      })
    ).toBe('clear')
  })

  it('starts a stationary hover before replacing the confirmed slot', () => {
    expect(
      getPlacementPreviewAction({
        currentPreviewKey: 'source:active',
        pendingCandidateKey: null,
        nextCandidateKey: '4:5:bottom',
        listMoved: false,
      })
    ).toBe('start-pending')
  })

  it('uses the source row as the only cyan slot after the card reattaches', () => {
    const offsetAt = (displayIndex: number) =>
      getSessionReorderVisualOffset({
        displayIndex,
        activeDisplayIndex: 4,
        dragDetached: false,
        placementTargetDisplayIndex: 4,
        placementEdge: 'bottom',
        placementKind: 'source',
        itemHeight: 48,
      })

    expect(offsetAt(4)).toBe(0)
    expect(offsetAt(5)).toBe(0)
    expect(offsetAt(6)).toBe(0)
  })

  it('restores only the compacted source slot while the card is still detached', () => {
    const offsetAt = (displayIndex: number) =>
      getSessionReorderVisualOffset({
        displayIndex,
        activeDisplayIndex: 4,
        dragDetached: true,
        placementTargetDisplayIndex: 4,
        placementEdge: 'bottom',
        placementKind: 'source',
        itemHeight: 48,
      })

    expect(offsetAt(4)).toBe(0)
    expect(offsetAt(5)).toBe(0)
    expect(offsetAt(6)).toBe(0)
  })

  it('opens exactly one cyan destination slot while moving downward', () => {
    const offsetAt = (displayIndex: number) =>
      getSessionReorderVisualOffset({
        displayIndex,
        activeDisplayIndex: 2,
        dragDetached: true,
        placementTargetDisplayIndex: 4,
        placementEdge: 'bottom',
        placementKind: 'destination',
        itemHeight: 48,
      })

    expect(offsetAt(2)).toBe(0)
    expect(offsetAt(3)).toBe(-48)
    expect(offsetAt(4)).toBe(-48)
    expect(offsetAt(5)).toBe(0)
  })

  it('keeps the cyan source slot stable across normal touch jitter', () => {
    expect(
      isWithinSourcePlacementZone({
        distanceFromSourceCenter: 23,
        sourceCandidateActive: false,
        itemHeight: 48,
      })
    ).toBe(true)
    expect(
      isWithinSourcePlacementZone({
        distanceFromSourceCenter: 27,
        sourceCandidateActive: false,
        itemHeight: 48,
      })
    ).toBe(false)
    expect(
      isWithinSourcePlacementZone({
        distanceFromSourceCenter: 27,
        sourceCandidateActive: true,
        itemHeight: 48,
      })
    ).toBe(true)
    expect(
      isWithinSourcePlacementZone({
        distanceFromSourceCenter: 31,
        sourceCandidateActive: true,
        itemHeight: 48,
      })
    ).toBe(false)
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

  it('moves cached items across a page boundary without rebuilding the list', () => {
    const pages = new Map([
      [0, ['a', 'b']],
      [2, ['c', 'd']],
    ])
    expect(moveItemInPagedCache(pages, 1, 3, 2)).toBe(true)
    expect(pages).toEqual(
      new Map([
        [0, ['a', 'c']],
        [2, ['d', 'b']],
      ])
    )
  })

  it('leaves cached pages unchanged when the move range contains an unloaded page', () => {
    const pages = new Map([
      [0, ['a', 'b']],
      [4, ['e', 'f']],
    ])
    expect(moveItemInPagedCache(pages, 1, 4, 2)).toBe(false)
    expect(pages).toEqual(
      new Map([
        [0, ['a', 'b']],
        [4, ['e', 'f']],
      ])
    )
  })

  it('requires a dragged item to enter the next row before switching targets', () => {
    expect(
      shouldSwitchReorderTarget({
        currentIndex: 10,
        candidateIndex: 11,
        dragCenterY: 59,
        candidateTop: 48,
        candidateBottom: 96,
      })
    ).toBe(false)
    expect(
      shouldSwitchReorderTarget({
        currentIndex: 10,
        candidateIndex: 11,
        dragCenterY: 60,
        candidateTop: 48,
        candidateBottom: 96,
      })
    ).toBe(true)
  })

  it('applies the same reorder hysteresis while moving upward', () => {
    expect(
      shouldSwitchReorderTarget({
        currentIndex: 11,
        candidateIndex: 10,
        dragCenterY: 37,
        candidateTop: 0,
        candidateBottom: 48,
      })
    ).toBe(false)
    expect(
      shouldSwitchReorderTarget({
        currentIndex: 11,
        candidateIndex: 10,
        dragCenterY: 36,
        candidateTop: 0,
        candidateBottom: 48,
      })
    ).toBe(true)
  })

  it('accelerates reorder scrolling quadratically near either viewport edge', () => {
    expect(
      getReorderEdgeScrollVelocity({
        pointerY: 500,
        viewportTop: 100,
        viewportBottom: 900,
        edgeZone: 100,
        maxSpeed: 1_000,
      })
    ).toBe(0)
    expect(
      getReorderEdgeScrollVelocity({
        pointerY: 850,
        viewportTop: 100,
        viewportBottom: 900,
        edgeZone: 100,
        maxSpeed: 1_000,
      })
    ).toBe(250)
    expect(
      getReorderEdgeScrollVelocity({
        pointerY: 100,
        viewportTop: 100,
        viewportBottom: 900,
        edgeZone: 100,
        maxSpeed: 1_000,
      })
    ).toBe(-1_000)
    expect(
      getReorderEdgeScrollVelocity({
        pointerY: 920,
        viewportTop: 100,
        viewportBottom: 900,
        edgeZone: 100,
        maxSpeed: 1_000,
      })
    ).toBe(1_000)
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
