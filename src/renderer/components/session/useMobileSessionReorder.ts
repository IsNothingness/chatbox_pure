import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { SessionMetaRecord } from '@shared/types'
import {
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import platform from '@/platform'
import { updateSession as updateSessionStore } from '@/stores/chatStore'
import { reorderSessions } from '@/stores/sessionActions'
import {
  getPlacementPreviewAction,
  getReorderEdgeScrollVelocity,
  getSessionListDisplayCount,
  getSessionListSlot,
  getSessionReorderTarget,
  isWithinSourcePlacementZone,
  type SessionPlacementPreviewKind,
  type SessionReorderGroup,
  sessionIndexToDisplayIndex,
} from './session-list-window'
import type { SparseSessionList } from './useSparseSessionList'

const ITEM_HEIGHT = 48
const LONG_PRESS_DELAY_MS = 500
const LONG_PRESS_TOLERANCE_PX = 5
const DETACH_DISTANCE_PX = 28
const SNAP_BACK_DURATION_MS = 180
const PLACEMENT_HOVER_DELAY_MS = 350
const PLACEMENT_GAP_HALF_ZONE_PX = 16
const PLACEMENT_MIN_HORIZONTAL_OVERLAP_RATIO = 0.6
const PLACEMENT_SCROLL_EPSILON_PX = 2

interface PlacementPreview {
  key: string
  targetIndex: number
  edge: 'top' | 'bottom'
  kind: SessionPlacementPreviewKind
}

interface PlacementCandidate extends PlacementPreview {
  key: string
  scrollTop: number
}

interface PendingDrag {
  input: 'pointer' | 'touch'
  pointerId: number
  captureElement: HTMLDivElement | null
  session: SessionMetaRecord
  sessionIndex: number
  startX: number
  startY: number
  rowElement: HTMLDivElement
  rowRect: DOMRect
  timer: number
}

interface ActiveDrag {
  input: 'pointer' | 'touch'
  pointerId: number
  captureElement: HTMLDivElement | null
  cleanupDirectTouchListeners: (() => void) | null
  session: SessionMetaRecord
  sessionIndex: number
  group: SessionReorderGroup
  startX: number
  startY: number
  currentX: number
  currentY: number
  originLeft: number
  width: number
  grabOffsetY: number
  viewportTop: number
  targetIndex: number
  crossedGroup: boolean
}

export interface MobileSessionReorder {
  activeDragId: string | null
  activeSession: SessionMetaRecord | null
  activeSessionIndex: number | null
  dragDetached: boolean
  targetIndex: number | null
  insertionEdge: 'top' | 'bottom' | null
  placementPreview: PlacementPreview | null
  unpinPromptId: string | null
  overlayOrigin: { left: number; top: number; width: number } | null
  overlayRef: RefObject<HTMLDivElement>
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, session: SessionMetaRecord, sessionIndex: number) => void
  onTouchStart: (event: ReactTouchEvent<HTMLDivElement>, session: SessionMetaRecord, sessionIndex: number) => void
  onSelectWhileReordering: () => boolean
  confirmUnpin: () => Promise<void>
  dismissUnpinPrompt: () => void
}

interface Options {
  enabled: boolean
  showSidebar: boolean
  isReordering: boolean
  onReorderingChange: (isReordering: boolean) => void
  onActiveDragChange?: (active: boolean) => void
  viewportRef: RefObject<HTMLDivElement>
  sparseList: SparseSessionList
}

export function useMobileSessionReorder(options: Options): MobileSessionReorder {
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [activeSession, setActiveSession] = useState<SessionMetaRecord | null>(null)
  const [activeSessionIndex, setActiveSessionIndex] = useState<number | null>(null)
  const [dragDetached, setDragDetached] = useState(false)
  const [targetIndex, setTargetIndex] = useState<number | null>(null)
  const [dragDirection, setDragDirection] = useState<-1 | 0 | 1>(0)
  const [placementPreview, setPlacementPreview] = useState<PlacementPreview | null>(null)
  const [unpinPromptId, setUnpinPromptId] = useState<string | null>(null)
  const [overlayOrigin, setOverlayOrigin] = useState<{ left: number; top: number; width: number } | null>(null)

  const pendingRef = useRef<PendingDrag | null>(null)
  const activeRef = useRef<ActiveDrag | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const overlayFrameRef = useRef<number | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const placementTimerRef = useRef<number | null>(null)
  const placementCandidateRef = useRef<PlacementCandidate | null>(null)
  const placementPreviewRef = useRef<PlacementPreview | null>(null)
  const placementObservedScrollTopRef = useRef(0)
  const settlingRef = useRef(false)
  const dragDetachedRef = useRef(false)
  const targetIndexRef = useRef<number | null>(null)
  const dragDirectionRef = useRef<-1 | 0 | 1>(0)
  const currentPointerYRef = useRef<number | null>(null)
  const lastDragFinishedAtRef = useRef(0)
  const recomputeTargetRef = useRef<(() => void) | null>(null)
  const pointerMoveHandlerRef = useRef<(event: PointerEvent) => void>(() => {})
  const pointerEndHandlerRef = useRef<(event: PointerEvent, cancelled: boolean) => void>(() => {})
  const touchMoveHandlerRef = useRef<(event: TouchEvent) => void>(() => {})
  const touchEndHandlerRef = useRef<(event: TouchEvent, cancelled: boolean) => void>(() => {})
  const lostPointerCaptureHandlerRef = useRef<(event: PointerEvent) => void>(() => {})
  const cancelGestureHandlerRef = useRef<() => void>(() => {})
  const handledTouchEventsRef = useRef(new WeakSet<Event>())

  const cancelPending = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    pendingRef.current = null
    if (pending.captureElement) {
      try {
        if (pending.captureElement.hasPointerCapture(pending.pointerId)) {
          pending.captureElement.releasePointerCapture(pending.pointerId)
        }
      } catch {
        // Native scrolling may already have cancelled and released the pointer.
      }
    }
  }, [])

  const updateDetached = useCallback((nextDetached: boolean) => {
    if (dragDetachedRef.current === nextDetached) return
    dragDetachedRef.current = nextDetached
    setDragDetached(nextDetached)
  }, [])

  const updateDirection = useCallback((nextDirection: -1 | 0 | 1) => {
    if (dragDirectionRef.current === nextDirection) return
    dragDirectionRef.current = nextDirection
    setDragDirection(nextDirection)
  }, [])

  const updateTargetIndex = useCallback((nextTargetIndex: number | null) => {
    if (targetIndexRef.current === nextTargetIndex) return
    targetIndexRef.current = nextTargetIndex
    setTargetIndex(nextTargetIndex)
  }, [])

  const clearOverlayFrame = useCallback(() => {
    if (overlayFrameRef.current === null) return
    cancelAnimationFrame(overlayFrameRef.current)
    overlayFrameRef.current = null
  }, [])

  const cancelPendingPlacementCandidate = useCallback(() => {
    if (placementTimerRef.current !== null) {
      window.clearTimeout(placementTimerRef.current)
      placementTimerRef.current = null
    }
    placementCandidateRef.current = null
  }, [])

  const clearPlacementCandidate = useCallback(() => {
    cancelPendingPlacementCandidate()
    placementPreviewRef.current = null
    setPlacementPreview(null)
  }, [cancelPendingPlacementCandidate])

  const resetDrag = useCallback(() => {
    cancelPending()
    clearOverlayFrame()
    clearPlacementCandidate()
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    const active = activeRef.current
    if (active) {
      activeRef.current = null
      active.cleanupDirectTouchListeners?.()
      try {
        if (active.captureElement?.hasPointerCapture(active.pointerId)) {
          active.captureElement.releasePointerCapture(active.pointerId)
        }
      } catch {
        // Android may have released capture already while dispatching
        // pointerup/pointercancel or while the drawer is closing.
      }
    }
    currentPointerYRef.current = null
    settlingRef.current = false
    dragDetachedRef.current = false
    targetIndexRef.current = null
    dragDirectionRef.current = 0
    options.onActiveDragChange?.(false)
    setActiveDragId(null)
    setActiveSession(null)
    setActiveSessionIndex(null)
    setDragDetached(false)
    setTargetIndex(null)
    setDragDirection(0)
    setOverlayOrigin(null)
  }, [cancelPending, clearOverlayFrame, clearPlacementCandidate, options.onActiveDragChange])

  const scheduleOverlayTransform = useCallback(() => {
    if (overlayFrameRef.current !== null) return
    overlayFrameRef.current = requestAnimationFrame(() => {
      overlayFrameRef.current = null
      const active = activeRef.current
      const overlay = overlayRef.current
      if (!active || !overlay) return
      const deltaX = active.currentX - active.startX
      const deltaY = active.currentY - active.startY
      overlay.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`
    })
  }, [])

  const recomputeTarget = useCallback(() => {
    const active = activeRef.current
    const viewport = options.viewportRef.current
    if (!active || !viewport) return

    const draggedCenterY = active.currentY - active.grabOffsetY + ITEM_HEIGHT / 2
    const contentY = draggedCenterY - active.viewportTop + viewport.scrollTop
    const displayCount = getSessionListDisplayCount(options.sparseList.total, options.sparseList.pinnedCount)
    const displayIndex = Math.max(0, Math.min(displayCount - 1, Math.floor(contentY / ITEM_HEIGHT)))
    const nextTarget = getSessionReorderTarget(
      displayIndex,
      options.sparseList.total,
      options.sparseList.pinnedCount,
      active.group
    )
    active.crossedGroup = nextTarget.crossedGroup
    active.targetIndex = nextTarget.targetIndex ?? active.sessionIndex
    updateTargetIndex(nextTarget.crossedGroup ? null : active.targetIndex)

    const deltaY = active.currentY - active.startY
    const nextDirection: -1 | 0 | 1 =
      active.targetIndex > active.sessionIndex
        ? 1
        : active.targetIndex < active.sessionIndex
          ? -1
          : deltaY > 0
            ? 1
            : deltaY < 0
              ? -1
              : 0
    updateDirection(nextDirection)
    updateDetached(Math.abs(deltaY) >= DETACH_DISTANCE_PX || active.targetIndex !== active.sessionIndex)

    const scrollTop = viewport.scrollTop
    const listMoved = Math.abs(scrollTop - placementObservedScrollTopRef.current) > PLACEMENT_SCROLL_EPSILON_PX
    placementObservedScrollTopRef.current = scrollTop
    if (nextTarget.crossedGroup) {
      clearPlacementCandidate()
      return
    }

    const viewportRect = viewport.getBoundingClientRect()
    const cardLeft = active.originLeft + (active.currentX - active.startX)
    const cardRight = cardLeft + active.width
    const horizontalOverlap =
      Math.max(0, Math.min(cardRight, viewportRect.right) - Math.max(cardLeft, viewportRect.left)) /
      Math.max(1, active.width)
    const cardCenterX = cardLeft + active.width / 2
    if (
      horizontalOverlap < PLACEMENT_MIN_HORIZONTAL_OVERLAP_RATIO ||
      cardCenterX < viewportRect.left ||
      cardCenterX > viewportRect.right
    ) {
      clearPlacementCandidate()
      return
    }

    const activeDisplayIndex = sessionIndexToDisplayIndex(active.sessionIndex, options.sparseList.pinnedCount)
    const sourceCenterY = activeDisplayIndex * ITEM_HEIGHT + ITEM_HEIGHT / 2
    const sourceCandidateActive =
      placementCandidateRef.current?.kind === 'source' || placementPreviewRef.current?.kind === 'source'
    let candidate: PlacementCandidate | null = null
    if (
      isWithinSourcePlacementZone({
        distanceFromSourceCenter: contentY - sourceCenterY,
        sourceCandidateActive,
        itemHeight: ITEM_HEIGHT,
      })
    ) {
      candidate = {
        key: `source:${active.session.id}`,
        targetIndex: active.sessionIndex,
        edge: 'bottom',
        kind: 'source',
        scrollTop,
      }
    } else if (nextDirection !== 0) {
      const placementContentY =
        dragDetachedRef.current && contentY >= activeDisplayIndex * ITEM_HEIGHT ? contentY + ITEM_HEIGHT : contentY
      const boundaryDisplayIndex = Math.round(placementContentY / ITEM_HEIGHT)
      if (Math.abs(placementContentY - boundaryDisplayIndex * ITEM_HEIGHT) <= PLACEMENT_GAP_HALF_ZONE_PX) {
        const upperSlot = getSessionListSlot(
          boundaryDisplayIndex - 1,
          options.sparseList.total,
          options.sparseList.pinnedCount
        )
        const lowerSlot = getSessionListSlot(
          boundaryDisplayIndex,
          options.sparseList.total,
          options.sparseList.pinnedCount
        )
        if (upperSlot?.type === 'session' && lowerSlot?.type === 'session') {
          const upperGroup: SessionReorderGroup =
            upperSlot.sessionIndex < options.sparseList.pinnedCount ? 'pinned' : 'chats'
          const lowerGroup: SessionReorderGroup =
            lowerSlot.sessionIndex < options.sparseList.pinnedCount ? 'pinned' : 'chats'
          if (
            upperGroup === active.group &&
            lowerGroup === active.group &&
            upperSlot.sessionIndex !== active.sessionIndex &&
            lowerSlot.sessionIndex !== active.sessionIndex
          ) {
            const edge = nextDirection > 0 ? 'bottom' : 'top'
            candidate = {
              key: `${upperSlot.sessionIndex}:${lowerSlot.sessionIndex}:${edge}`,
              targetIndex: nextDirection > 0 ? upperSlot.sessionIndex : lowerSlot.sessionIndex,
              edge,
              kind: 'destination',
              scrollTop,
            }
          }
        }
      }
    }
    const previewAction = getPlacementPreviewAction({
      currentPreviewKey: placementPreviewRef.current?.key ?? null,
      pendingCandidateKey: placementCandidateRef.current?.key ?? null,
      nextCandidateKey: candidate?.key ?? null,
      listMoved,
    })
    if (previewAction === 'clear') {
      clearPlacementCandidate()
      return
    }
    if (previewAction === 'keep-confirmed') {
      cancelPendingPlacementCandidate()
      placementCandidateRef.current = candidate
      return
    }
    if (previewAction === 'keep-pending') return

    // A cyan slot only describes the area currently being hovered. Clear the
    // previous slot before timing a different one so stale previews cannot
    // remain after the finger has moved away.
    clearPlacementCandidate()
    placementCandidateRef.current = candidate
    placementTimerRef.current = window.setTimeout(() => {
      placementTimerRef.current = null
      const currentCandidate = placementCandidateRef.current
      const currentViewport = options.viewportRef.current
      if (
        !activeRef.current ||
        currentCandidate?.key !== candidate.key ||
        !currentViewport ||
        Math.abs(currentViewport.scrollTop - candidate.scrollTop) > PLACEMENT_SCROLL_EPSILON_PX
      ) {
        if (placementCandidateRef.current?.key === candidate.key) {
          placementCandidateRef.current = null
        }
        return
      }
      const preview = {
        key: candidate.key,
        targetIndex: candidate.targetIndex,
        edge: candidate.edge,
        kind: candidate.kind,
      }
      placementPreviewRef.current = preview
      setPlacementPreview(preview)
    }, PLACEMENT_HOVER_DELAY_MS)
  }, [
    cancelPendingPlacementCandidate,
    clearPlacementCandidate,
    options.sparseList.pinnedCount,
    options.sparseList.total,
    options.viewportRef,
    updateDetached,
    updateDirection,
    updateTargetIndex,
  ])
  recomputeTargetRef.current = recomputeTarget

  const beginDrag = useCallback(
    (pending: PendingDrag) => {
      if (pendingRef.current !== pending || !options.enabled) return
      pendingRef.current = null
      const viewport = options.viewportRef.current
      if (!viewport) return

      const viewportRect = viewport.getBoundingClientRect()
      const group: SessionReorderGroup = pending.session.starred ? 'pinned' : 'chats'
      const active: ActiveDrag = {
        input: pending.input,
        pointerId: pending.pointerId,
        captureElement: pending.captureElement,
        cleanupDirectTouchListeners: null,
        session: pending.session,
        sessionIndex: pending.sessionIndex,
        group,
        startX: pending.startX,
        startY: pending.startY,
        currentX: pending.startX,
        currentY: pending.startY,
        originLeft: pending.rowRect.left,
        width: pending.rowRect.width,
        grabOffsetY: pending.startY - pending.rowRect.top,
        viewportTop: viewportRect.top,
        targetIndex: pending.sessionIndex,
        crossedGroup: false,
      }
      if (pending.input === 'touch') {
        const handleDirectMove = (event: TouchEvent) => touchMoveHandlerRef.current(event)
        const handleDirectEnd = (event: TouchEvent) => touchEndHandlerRef.current(event, false)
        const handleDirectCancel = (event: TouchEvent) => touchEndHandlerRef.current(event, true)
        pending.rowElement.addEventListener('touchmove', handleDirectMove, { passive: false })
        pending.rowElement.addEventListener('touchend', handleDirectEnd, { passive: false })
        pending.rowElement.addEventListener('touchcancel', handleDirectCancel, { passive: false })
        active.cleanupDirectTouchListeners = () => {
          pending.rowElement.removeEventListener('touchmove', handleDirectMove)
          pending.rowElement.removeEventListener('touchend', handleDirectEnd)
          pending.rowElement.removeEventListener('touchcancel', handleDirectCancel)
        }
      }
      activeRef.current = active
      settlingRef.current = false
      currentPointerYRef.current = pending.startY
      placementObservedScrollTopRef.current = viewport.scrollTop
      dragDetachedRef.current = false
      targetIndexRef.current = pending.sessionIndex
      dragDirectionRef.current = 0
      setUnpinPromptId(null)
      if (pending.input === 'pointer' && !active.captureElement) {
        try {
          // Capture on the stable scroll viewport rather than the pressed row.
          // Virtuoso is allowed to unmount that row during edge auto-scroll;
          // keeping capture on the viewport prevents Android WebView from
          // losing all subsequent move/up events when that happens.
          viewport.setPointerCapture(pending.pointerId)
          active.captureElement = viewport
        } catch {
          // Window-level listeners continue tracking the gesture when pointer
          // capture is unavailable in a particular WebView.
        }
      }

      flushSync(() => {
        options.onActiveDragChange?.(true)
        setActiveDragId(pending.session.id)
        setActiveSession(pending.session)
        setActiveSessionIndex(pending.sessionIndex)
        setTargetIndex(pending.sessionIndex)
        setDragDetached(false)
        setDragDirection(0)
        setOverlayOrigin({
          left: pending.rowRect.left,
          top: pending.rowRect.top,
          width: pending.rowRect.width,
        })
        options.onReorderingChange(true)
      })

      if (platform.type === 'mobile') {
        void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
          navigator.vibrate?.(10)
        })
      }
    },
    [options.enabled, options.onActiveDragChange, options.onReorderingChange, options.viewportRef]
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, session: SessionMetaRecord, sessionIndex: number) => {
      // Android WebView cancels captured touch pointers as soon as the finger
      // starts moving after a long press. Finger gestures therefore stay on
      // the Touch Event path; Pointer Events are only used for mouse/pen input.
      if (!options.enabled || event.button !== 0 || event.pointerType === 'touch' || activeRef.current) return
      const target = event.target as Element
      if (target.closest('button, a, input, textarea, [role="menuitem"]')) return

      cancelPending()
      setUnpinPromptId(null)
      const rowElement = event.currentTarget
      const pending: PendingDrag = {
        input: 'pointer',
        pointerId: event.pointerId,
        captureElement: null,
        session,
        sessionIndex,
        startX: event.clientX,
        startY: event.clientY,
        rowElement,
        rowRect: rowElement.getBoundingClientRect(),
        timer: 0,
      }
      pending.timer = window.setTimeout(() => beginDrag(pending), LONG_PRESS_DELAY_MS)
      pendingRef.current = pending
    },
    [beginDrag, cancelPending, options.enabled]
  )

  const onTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>, session: SessionMetaRecord, sessionIndex: number) => {
      if (!options.enabled || activeRef.current || event.touches.length !== 1) return
      const target = event.target as Element
      if (target.closest('button, a, input, textarea, [role="menuitem"]')) return
      const touch = event.touches[0]

      cancelPending()
      setUnpinPromptId(null)
      const rowElement = event.currentTarget
      const pending: PendingDrag = {
        input: 'touch',
        pointerId: touch.identifier,
        captureElement: null,
        session,
        sessionIndex,
        startX: touch.clientX,
        startY: touch.clientY,
        rowElement,
        rowRect: rowElement.getBoundingClientRect(),
        timer: 0,
      }
      pending.timer = window.setTimeout(() => beginDrag(pending), LONG_PRESS_DELAY_MS)
      pendingRef.current = pending
    },
    [beginDrag, cancelPending, options.enabled]
  )

  const snapBack = useCallback(
    (offerUnpin: boolean) => {
      const active = activeRef.current
      if (!active || settlingRef.current) return
      settlingRef.current = true
      lastDragFinishedAtRef.current = Date.now()
      currentPointerYRef.current = null
      // A placement preview only describes a live, held gesture. Remove it as
      // soon as the finger is released so no portal can linger during snapback.
      clearPlacementCandidate()
      updateDetached(false)
      updateTargetIndex(active.sessionIndex)

      clearOverlayFrame()
      const overlay = overlayRef.current
      if (overlay) {
        overlay.style.transition = `transform ${SNAP_BACK_DURATION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`
        overlay.style.transform = 'translate3d(0, 0, 0)'
      }
      const promptSessionId = offerUnpin ? active.session.id : null
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null
        resetDrag()
        if (promptSessionId) setUnpinPromptId(promptSessionId)
      }, SNAP_BACK_DURATION_MS)
    },
    [clearOverlayFrame, clearPlacementCandidate, resetDrag, updateDetached, updateTargetIndex]
  )

  const finishDrag = useCallback(
    async (cancelled: boolean) => {
      const active = activeRef.current
      if (!active || settlingRef.current) return
      // Only the cyan slot is a confirmed drop target. If it was cleared by a
      // hard boundary or no slot has completed the hover delay, snap back.
      const finalTargetIndex = placementPreviewRef.current?.targetIndex ?? active.sessionIndex
      if (cancelled || active.crossedGroup || finalTargetIndex === active.sessionIndex) {
        snapBack(!cancelled && active.group === 'pinned' && active.crossedGroup)
        return
      }

      const oldIndex = active.sessionIndex
      const newIndex = finalTargetIndex
      lastDragFinishedAtRef.current = Date.now()
      const movedOptimistically = options.sparseList.moveSession(oldIndex, newIndex)
      resetDrag()
      try {
        await reorderSessions(oldIndex, newIndex)
      } catch (error) {
        if (movedOptimistically) options.sparseList.moveSession(newIndex, oldIndex)
        console.error('Failed to reorder sessions:', error)
      }
    },
    [options.sparseList, resetDrag, snapBack]
  )

  pointerMoveHandlerRef.current = (event: PointerEvent) => {
    const pending = pendingRef.current
    if (pending?.input === 'pointer' && pending.pointerId === event.pointerId) {
      const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY)
      if (distance > LONG_PRESS_TOLERANCE_PX) cancelPending()
      return
    }

    const active = activeRef.current
    if (!active || active.input !== 'pointer' || active.pointerId !== event.pointerId) return
    event.preventDefault()
    active.currentX = event.clientX
    active.currentY = event.clientY
    currentPointerYRef.current = event.clientY
    scheduleOverlayTransform()
    recomputeTargetRef.current?.()
  }

  pointerEndHandlerRef.current = (event: PointerEvent, cancelled: boolean) => {
    const pending = pendingRef.current
    if (pending?.input === 'pointer' && pending.pointerId === event.pointerId) {
      cancelPending()
      return
    }
    const active = activeRef.current
    if (!active || active.input !== 'pointer' || active.pointerId !== event.pointerId) return
    event.preventDefault()
    active.currentX = event.clientX
    active.currentY = event.clientY
    currentPointerYRef.current = event.clientY
    recomputeTargetRef.current?.()
    void finishDrag(cancelled)
  }

  touchMoveHandlerRef.current = (event: TouchEvent) => {
    if (handledTouchEventsRef.current.has(event)) return
    handledTouchEventsRef.current.add(event)
    const pending = pendingRef.current
    if (pending?.input === 'touch') {
      const touch = Array.from(event.touches).find((item) => item.identifier === pending.pointerId)
      if (!touch) return
      const distance = Math.hypot(touch.clientX - pending.startX, touch.clientY - pending.startY)
      if (distance > LONG_PRESS_TOLERANCE_PX) cancelPending()
      return
    }

    const active = activeRef.current
    if (!active || active.input !== 'touch') return
    const touch = Array.from(event.touches).find((item) => item.identifier === active.pointerId)
    if (!touch) return
    event.preventDefault()
    active.currentX = touch.clientX
    active.currentY = touch.clientY
    currentPointerYRef.current = touch.clientY
    scheduleOverlayTransform()
    recomputeTargetRef.current?.()
  }

  touchEndHandlerRef.current = (event: TouchEvent, cancelled: boolean) => {
    if (handledTouchEventsRef.current.has(event)) return
    handledTouchEventsRef.current.add(event)
    const pending = pendingRef.current
    if (pending?.input === 'touch') {
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === pending.pointerId)
      const stillActive = Array.from(event.touches).some((item) => item.identifier === pending.pointerId)
      if (touch || cancelled || !stillActive) cancelPending()
      return
    }

    const active = activeRef.current
    if (!active || active.input !== 'touch') return
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === active.pointerId)
    const stillActive = Array.from(event.touches).some((item) => item.identifier === active.pointerId)
    if (!touch && !cancelled && stillActive) return
    event.preventDefault()
    if (touch) {
      active.currentX = touch.clientX
      active.currentY = touch.clientY
      currentPointerYRef.current = touch.clientY
    }
    recomputeTargetRef.current?.()
    void finishDrag(cancelled)
  }

  cancelGestureHandlerRef.current = () => {
    cancelPending()
    if (activeRef.current) void finishDrag(true)
  }

  lostPointerCaptureHandlerRef.current = (event: PointerEvent) => {
    const active = activeRef.current
    if (!active || active.input !== 'pointer' || active.pointerId !== event.pointerId || settlingRef.current) return
    currentPointerYRef.current = null
    void finishDrag(true)
  }

  useEffect(() => {
    if (!options.enabled) return
    const handleMove = (event: PointerEvent) => pointerMoveHandlerRef.current(event)
    const handleUp = (event: PointerEvent) => pointerEndHandlerRef.current(event, false)
    const handleCancel = (event: PointerEvent) => pointerEndHandlerRef.current(event, true)
    const handleTouchMove = (event: TouchEvent) => touchMoveHandlerRef.current(event)
    const handleTouchEnd = (event: TouchEvent) => touchEndHandlerRef.current(event, false)
    const handleTouchCancel = (event: TouchEvent) => touchEndHandlerRef.current(event, true)
    const handleLostPointerCapture = (event: PointerEvent) => lostPointerCaptureHandlerRef.current(event)
    const handleWindowBlur = () => cancelGestureHandlerRef.current()
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') cancelGestureHandlerRef.current()
    }
    window.addEventListener('pointermove', handleMove, { capture: true, passive: false })
    window.addEventListener('pointerup', handleUp, { capture: true, passive: false })
    window.addEventListener('pointercancel', handleCancel, { capture: true, passive: false })
    window.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false })
    window.addEventListener('touchend', handleTouchEnd, { capture: true, passive: false })
    window.addEventListener('touchcancel', handleTouchCancel, { capture: true, passive: false })
    window.addEventListener('lostpointercapture', handleLostPointerCapture, true)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('pagehide', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pointermove', handleMove, true)
      window.removeEventListener('pointerup', handleUp, true)
      window.removeEventListener('pointercancel', handleCancel, true)
      window.removeEventListener('touchmove', handleTouchMove, true)
      window.removeEventListener('touchend', handleTouchEnd, true)
      window.removeEventListener('touchcancel', handleTouchCancel, true)
      window.removeEventListener('lostpointercapture', handleLostPointerCapture, true)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('pagehide', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [options.enabled])

  useEffect(() => {
    if (!activeDragId) return
    const viewport = options.viewportRef.current
    if (!viewport) return

    let animationFrame = 0
    let previousFrameAt = performance.now()
    let viewportRect = viewport.getBoundingClientRect()
    const updateViewportRect = () => {
      viewportRect = viewport.getBoundingClientRect()
      const active = activeRef.current
      if (active) active.viewportTop = viewportRect.top
    }
    const handleViewportScroll = () => {
      if (Math.abs(viewport.scrollTop - placementObservedScrollTopRef.current) <= PLACEMENT_SCROLL_EPSILON_PX) {
        return
      }
      recomputeTargetRef.current?.()
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateViewportRect)
    resizeObserver?.observe(viewport)
    window.addEventListener('resize', updateViewportRect)
    viewport.addEventListener('scroll', handleViewportScroll, { passive: true })

    const scrollTowardPointer = (now: number) => {
      const pointerY = currentPointerYRef.current
      const elapsedSeconds = Math.min(1 / 30, Math.max(0, now - previousFrameAt) / 1_000)
      previousFrameAt = now
      const capturedDrag = activeRef.current
      if (
        capturedDrag?.input === 'pointer' &&
        capturedDrag.captureElement &&
        !capturedDrag.captureElement.hasPointerCapture(capturedDrag.pointerId)
      ) {
        currentPointerYRef.current = null
        cancelGestureHandlerRef.current()
        animationFrame = requestAnimationFrame(scrollTowardPointer)
        return
      }
      if (pointerY !== null) {
        const velocity = getReorderEdgeScrollVelocity({
          pointerY,
          viewportTop: viewportRect.top,
          viewportBottom: viewportRect.bottom,
        })
        const active = activeRef.current
        const scrollingFartherAcrossBoundary =
          active?.crossedGroup === true &&
          ((active.group === 'pinned' && velocity > 0) || (active.group === 'chats' && velocity < 0))
        if (velocity !== 0 && !scrollingFartherAcrossBoundary) {
          const previousScrollTop = viewport.scrollTop
          viewport.scrollTop += velocity * elapsedSeconds
          if (viewport.scrollTop === previousScrollTop) {
            currentPointerYRef.current = null
          } else {
            recomputeTargetRef.current?.()
          }
        }
      }
      animationFrame = requestAnimationFrame(scrollTowardPointer)
    }

    animationFrame = requestAnimationFrame(scrollTowardPointer)
    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateViewportRect)
      viewport.removeEventListener('scroll', handleViewportScroll)
    }
  }, [activeDragId, options.viewportRef])

  useEffect(() => {
    if (options.showSidebar) return
    resetDrag()
    setUnpinPromptId(null)
  }, [options.showSidebar, resetDrag])

  useEffect(() => {
    if (options.isReordering || !activeRef.current) return
    resetDrag()
  }, [options.isReordering, resetDrag])

  useEffect(
    () => () => {
      resetDrag()
    },
    [resetDrag]
  )

  const onSelectWhileReordering = useCallback(() => {
    if (activeRef.current || Date.now() - lastDragFinishedAtRef.current < 250) return false
    options.onReorderingChange(false)
    return true
  }, [options.onReorderingChange])

  const dismissUnpinPrompt = useCallback(() => setUnpinPromptId(null), [])

  const confirmUnpin = useCallback(async () => {
    const sessionId = unpinPromptId
    if (!sessionId) return
    setUnpinPromptId(null)
    try {
      await updateSessionStore(sessionId, { starred: false })
    } catch (error) {
      console.error('Failed to unpin session after reorder gesture:', error)
    }
  }, [unpinPromptId])

  const insertionEdge: 'top' | 'bottom' | null =
    !dragDetached || targetIndex === null || activeSessionIndex === null || dragDirection === 0
      ? null
      : targetIndex > activeSessionIndex
        ? 'bottom'
        : targetIndex < activeSessionIndex
          ? 'top'
          : dragDirection > 0
            ? 'bottom'
            : 'top'

  return {
    activeDragId,
    activeSession,
    activeSessionIndex,
    dragDetached,
    targetIndex,
    insertionEdge,
    placementPreview,
    unpinPromptId,
    overlayOrigin,
    overlayRef,
    onPointerDown,
    onTouchStart,
    onSelectWhileReordering,
    confirmUnpin,
    dismissUnpinPrompt,
  }
}
