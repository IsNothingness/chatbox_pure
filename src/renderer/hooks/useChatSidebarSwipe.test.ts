// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { shouldToggleSidebarFromSwipe } from './useChatSidebarSwipe'

const baseSwipe = {
  startX: 200,
  startY: 300,
  endX: 280,
  endY: 306,
  elapsedMs: 180,
  viewportWidth: 400,
  sidebarOpen: false,
  rtl: false,
  edgeNavigation: false,
  systemGestureInsetLeft: 0,
  systemGestureInsetRight: 0,
}

describe('chat sidebar swipe decision', () => {
  it('opens on a right swipe and closes on a left swipe', () => {
    expect(shouldToggleSidebarFromSwipe(baseSwipe)).toBe(true)
    expect(
      shouldToggleSidebarFromSwipe({
        ...baseSwipe,
        sidebarOpen: true,
        startX: 280,
        endX: 200,
      })
    ).toBe(true)
  })

  it('rejects vertical motion and the wrong direction', () => {
    expect(shouldToggleSidebarFromSwipe({ ...baseSwipe, endX: 230, endY: 380 })).toBe(false)
    expect(shouldToggleSidebarFromSwipe({ ...baseSwipe, endX: 120 })).toBe(false)
  })

  it('excludes system gesture edge bands when edge navigation is active', () => {
    expect(
      shouldToggleSidebarFromSwipe({
        ...baseSwipe,
        startX: 20,
        endX: 100,
        edgeNavigation: true,
        systemGestureInsetLeft: 24,
        systemGestureInsetRight: 24,
      })
    ).toBe(false)
    expect(
      shouldToggleSidebarFromSwipe({
        ...baseSwipe,
        startX: 60,
        endX: 140,
        edgeNavigation: true,
        systemGestureInsetLeft: 24,
        systemGestureInsetRight: 24,
      })
    ).toBe(true)
  })

  it('reverses directions for RTL layouts', () => {
    expect(
      shouldToggleSidebarFromSwipe({
        ...baseSwipe,
        rtl: true,
        startX: 280,
        endX: 200,
      })
    ).toBe(true)
  })
})
