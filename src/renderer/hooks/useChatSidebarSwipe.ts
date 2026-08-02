import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { useEffect } from 'react'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import { useLanguage } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'

const MIN_SWIPE_DISTANCE = 56
const MIN_FAST_SWIPE_DISTANCE = 36
const MIN_FAST_SWIPE_VELOCITY = 0.55
const HORIZONTAL_DIRECTION_RATIO = 1.35

interface SwipeDecision {
  startX: number
  startY: number
  endX: number
  endY: number
  elapsedMs: number
  viewportWidth: number
  sidebarOpen: boolean
  rtl: boolean
  edgeNavigation: boolean
  systemGestureInsetLeft: number
  systemGestureInsetRight: number
}

export function shouldToggleSidebarFromSwipe(input: SwipeDecision): boolean {
  const gestureGuardLeft = input.edgeNavigation ? Math.max(32, input.systemGestureInsetLeft + 12) : 0
  const gestureGuardRight = input.edgeNavigation ? Math.max(32, input.systemGestureInsetRight + 12) : 0
  if (
    input.startX < gestureGuardLeft ||
    input.startX > Math.max(gestureGuardLeft, input.viewportWidth - gestureGuardRight)
  ) {
    return false
  }

  const deltaX = input.endX - input.startX
  const deltaY = input.endY - input.startY
  const horizontalDistance = Math.abs(deltaX)
  if (horizontalDistance < Math.abs(deltaY) * HORIZONTAL_DIRECTION_RATIO) return false

  const velocity = horizontalDistance / Math.max(1, input.elapsedMs)
  if (
    horizontalDistance < MIN_SWIPE_DISTANCE &&
    (horizontalDistance < MIN_FAST_SWIPE_DISTANCE || velocity < MIN_FAST_SWIPE_VELOCITY)
  ) {
    return false
  }

  const openingDirection = input.rtl ? deltaX < 0 : deltaX > 0
  return input.sidebarOpen ? !openingDirection : openingDirection
}

function cssPixelValue(property: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(property)
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function hasHorizontalScrollTarget(target: Element): boolean {
  let element: Element | null = target
  while (element && element !== document.body) {
    if (element instanceof HTMLElement) {
      const style = getComputedStyle(element)
      if (
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        element.scrollWidth > element.clientWidth + 1
      ) {
        return true
      }
    }
    element = element.parentElement
  }
  return false
}

export function shouldIgnoreSidebarSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  if (
    target.closest(
      'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [data-sidebar-swipe-ignore]'
    )
  ) {
    return true
  }
  if (hasHorizontalScrollTarget(target)) return true
  const selection = window.getSelection()
  return Boolean(selection && !selection.isCollapsed)
}

interface ActiveTouch {
  identifier: number
  startX: number
  startY: number
  startedAt: number
  sidebarOpen: boolean
}

export function useChatSidebarSwipe() {
  const isSmallScreen = useIsSmallScreen()
  const language = useLanguage()
  const showSidebar = useUIStore((state) => state.showSidebar)
  const setShowSidebar = useUIStore((state) => state.setShowSidebar)

  useEffect(() => {
    if (!isSmallScreen) return

    let activeTouch: ActiveTouch | null = null

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || shouldIgnoreSidebarSwipeTarget(event.target)) {
        activeTouch = null
        return
      }
      const touch = event.touches[0]
      activeTouch = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: performance.now(),
        sidebarOpen: showSidebar,
      }
    }

    const handleTouchEnd = (event: TouchEvent) => {
      if (!activeTouch) return
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === activeTouch?.identifier)
      const started = activeTouch
      activeTouch = null
      if (!touch) return

      const shouldToggle = shouldToggleSidebarFromSwipe({
        startX: started.startX,
        startY: started.startY,
        endX: touch.clientX,
        endY: touch.clientY,
        elapsedMs: performance.now() - started.startedAt,
        viewportWidth: window.innerWidth,
        sidebarOpen: started.sidebarOpen,
        rtl: language === 'ar',
        edgeNavigation: document.documentElement.dataset.systemGestureNavigation === 'true',
        systemGestureInsetLeft: cssPixelValue('--mobile-system-gesture-inset-left'),
        systemGestureInsetRight: cssPixelValue('--mobile-system-gesture-inset-right'),
      })
      if (!shouldToggle) return

      setShowSidebar(!started.sidebarOpen)
      void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
        navigator.vibrate?.(8)
      })
    }

    const cancelTouch = () => {
      activeTouch = null
    }

    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true })
    document.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true })
    document.addEventListener('touchcancel', cancelTouch, { capture: true, passive: true })
    return () => {
      document.removeEventListener('touchstart', handleTouchStart, true)
      document.removeEventListener('touchend', handleTouchEnd, true)
      document.removeEventListener('touchcancel', cancelTouch, true)
    }
  }, [isSmallScreen, language, setShowSidebar, showSidebar])
}
