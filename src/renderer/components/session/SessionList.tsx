import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { CollisionDetection, DragEndEvent, DragMoveEvent, DragOverEvent, UniqueIdentifier } from '@dnd-kit/core'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, type SortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { Button, Flex, Popover, Stack, Text } from '@mantine/core'
import type { SessionMetaRecord } from '@shared/types'
import { areSessionsInSamePinGroup } from '@shared/utils/session-sort'
import { IconLoader2 } from '@tabler/icons-react'
import { useRouterState } from '@tanstack/react-router'
import {
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import platform from '@/platform'
import { reorderSessions } from '@/stores/sessionActions'
import { useUIStore } from '@/stores/uiStore'
import SessionItem from './SessionItem'
import {
  getReorderEdgeScrollVelocity,
  getSessionReorderVisualOffset,
  sessionIndexToDisplayIndex,
  shouldSwitchReorderTarget,
} from './session-list-window'
import { useMobileSessionReorder } from './useMobileSessionReorder'
import { useSparseSessionList } from './useSparseSessionList'

export interface Props {
  sessionListViewportRef: MutableRefObject<HTMLDivElement | null>
  initialCenterSessionId?: string | null
  onContentWidthHint?: (width: number) => void
  isReordering: boolean
  onReorderingChange: (isReordering: boolean) => void
}

function SessionListLoadingFooter() {
  return (
    <Flex justify="center" py="xs">
      <IconLoader2 size={16} className="animate-spin" style={{ color: 'var(--mantine-color-dimmed)' }} />
    </Flex>
  )
}

function SessionListPlaceholder(props: { height?: number }) {
  return (
    <div aria-hidden className="mx-2 flex items-center gap-2 rounded-sm px-2" style={{ height: props.height ?? 48 }}>
      <div className="h-7 w-7 shrink-0 rounded-full bg-chatbox-background-gray-secondary opacity-70" />
      <div className="h-3 w-2/3 rounded-full bg-chatbox-background-gray-secondary opacity-70" />
    </div>
  )
}

const SESSION_LIST_ITEM_HEIGHT = 48
const SESSION_LIST_RENDER_AHEAD_PX = 1_152
const SESSION_LIST_MIN_OVERSCAN_ITEMS = 24
const SESSION_ITEM_NON_TEXT_WIDTH = 104
const TOUCH_LONG_PRESS_DELAY_MS = 500
const TOUCH_LONG_PRESS_TOLERANCE_PX = 5
const REORDER_DETACH_DISTANCE_PX = 28
// The list renders its own compacted gap and insertion marker. Asking dnd-kit
// to calculate a transform for every overscanned row on every pointer move is
// wasted work, especially inside the Android glass sidebar.
const stationarySortingStrategy: SortingStrategy = () => null

function getPointerClientY(event: Event): number | null {
  if ('clientY' in event && typeof event.clientY === 'number') {
    return event.clientY
  }
  if ('touches' in event) {
    const touch = (event as TouchEvent).touches[0] ?? (event as TouchEvent).changedTouches[0]
    return touch?.clientY ?? null
  }
  return null
}

function claimTouchForSessionList(event: ReactTouchEvent<HTMLDivElement>) {
  ;(event.nativeEvent as TouchEvent & { defaultMuiPrevented?: boolean }).defaultMuiPrevented = true
}

export default function SessionList(props: Props) {
  const { t } = useTranslation()
  const isSmallScreen = useIsSmallScreen()
  const showSidebar = useUIStore((state) => state.showSidebar)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const hasAppliedInitialCenterRef = useRef(false)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [previewTargetId, setPreviewTargetId] = useState<string | null>(null)
  const [dragDetached, setDragDetached] = useState(false)
  const [dragDirection, setDragDirection] = useState<-1 | 0 | 1>(0)
  const [mobileDragActive, setMobileDragActive] = useState(false)
  const isReordering = props.isReordering
  const setIsReordering = props.onReorderingChange
  const sparseList = useSparseSessionList({ pauseEviction: activeDragId !== null || mobileDragActive })
  const sortedSessions = useMemo(
    () => (isSmallScreen ? [] : sparseList.loadedEntries.map((entry) => entry.session)),
    [isSmallScreen, sparseList.loadedEntries]
  )
  const lastDragFinishedAtRef = useRef(0)
  const collisionTargetIdRef = useRef<UniqueIdentifier | null>(null)
  const previewTargetIdRef = useRef<string | null>(null)
  const dragDetachedRef = useRef(false)
  const dragDirectionRef = useRef<-1 | 0 | 1>(0)
  const currentPointerYRef = useRef<number | null>(null)
  const lastDragDeltaYRef = useRef(0)
  const measuredSessionTitlesRef = useRef(new Map<string, string>())
  const widestSessionTitleRef = useRef(0)
  const mobileReorder = useMobileSessionReorder({
    enabled: isSmallScreen,
    showSidebar,
    isReordering,
    onReorderingChange: setIsReordering,
    onActiveDragChange: setMobileDragActive,
    viewportRef: props.sessionListViewportRef,
    sparseList,
  })
  useEffect(() => {
    const sessionId = props.initialCenterSessionId
    if (
      !isSmallScreen ||
      !showSidebar ||
      !sessionId ||
      sparseList.isInitializing ||
      hasAppliedInitialCenterRef.current
    ) {
      return
    }

    let cancelled = false
    void sparseList.ensureSessionLoaded(sessionId).then((sessionIndex) => {
      if (cancelled || !showSidebar) return
      if (sessionIndex === null) {
        hasAppliedInitialCenterRef.current = true
        return
      }

      requestAnimationFrame(() => {
        if (cancelled || !showSidebar || hasAppliedInitialCenterRef.current) return
        virtuosoRef.current?.scrollToIndex({
          index: sessionIndexToDisplayIndex(sessionIndex, sparseList.pinnedCount),
          align: 'center',
          behavior: 'auto',
        })
        hasAppliedInitialCenterRef.current = true
      })
    })

    return () => {
      cancelled = true
    }
  }, [
    isSmallScreen,
    props.initialCenterSessionId,
    showSidebar,
    sparseList.ensureSessionLoaded,
    sparseList.isInitializing,
    sparseList.pinnedCount,
  ])
  useEffect(() => {
    if (!isSmallScreen || !props.onContentWidthHint || sparseList.loadedEntries.length === 0) return
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return
    context.font = getComputedStyle(document.body).font || '14px sans-serif'
    let widestTitle = widestSessionTitleRef.current
    for (const { session } of sparseList.loadedEntries) {
      const title = session.name || ''
      if (measuredSessionTitlesRef.current.get(session.id) === title) continue
      measuredSessionTitlesRef.current.set(session.id, title)
      widestTitle = Math.max(widestTitle, context.measureText(title).width)
    }
    if (widestTitle <= widestSessionTitleRef.current) return
    widestSessionTitleRef.current = widestTitle
    props.onContentWidthHint(widestTitle + SESSION_ITEM_NON_TEXT_WIDTH)
  }, [isSmallScreen, props.onContentWidthHint, sparseList.loadedEntries])
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      // Match Android's long-press feedback threshold so the UI enters reorder
      // mode at the same moment the user feels the press has been accepted.
      delay: TOUCH_LONG_PRESS_DELAY_MS,
      // A small drift should be treated as scrolling rather than selection.
      tolerance: TOUCH_LONG_PRESS_TOLERANCE_PX,
    },
  })
  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: {
      distance: 10,
    },
  })
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })
  const sensors = useSensors(touchSensor, mouseSensor, keyboardSensor)
  const updateDragDetached = useCallback((nextDetached: boolean) => {
    if (dragDetachedRef.current === nextDetached) return
    dragDetachedRef.current = nextDetached
    setDragDetached(nextDetached)
  }, [])
  const updateDragDirection = useCallback((nextDirection: -1 | 0 | 1) => {
    if (dragDirectionRef.current === nextDirection) return
    dragDirectionRef.current = nextDirection
    setDragDirection(nextDirection)
  }, [])

  useEffect(() => {
    if (!activeDragId) return

    const updatePointer = (event: PointerEvent) => {
      currentPointerYRef.current = event.clientY
    }
    const updateTouch = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0]
      if (touch) currentPointerYRef.current = touch.clientY
    }

    window.addEventListener('pointermove', updatePointer, { passive: true })
    window.addEventListener('touchmove', updateTouch, { passive: true })
    return () => {
      window.removeEventListener('pointermove', updatePointer)
      window.removeEventListener('touchmove', updateTouch)
    }
  }, [activeDragId])

  useEffect(() => {
    if (!activeDragId) return

    const viewport = props.sessionListViewportRef.current
    if (!viewport) return

    let animationFrame = 0
    let previousFrameAt = performance.now()
    let viewportRect = viewport.getBoundingClientRect()
    const updateViewportRect = () => {
      viewportRect = viewport.getBoundingClientRect()
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateViewportRect)
    resizeObserver?.observe(viewport)
    window.addEventListener('resize', updateViewportRect)

    const scrollTowardPointer = (now: number) => {
      const pointerY = currentPointerYRef.current
      const elapsedSeconds = Math.min(0.05, Math.max(0, now - previousFrameAt) / 1_000)
      previousFrameAt = now

      if (pointerY !== null) {
        const velocity = getReorderEdgeScrollVelocity({
          pointerY,
          viewportTop: viewportRect.top,
          viewportBottom: viewportRect.bottom,
        })
        if (velocity !== 0) {
          viewport.scrollTop += velocity * elapsedSeconds
        }
      }

      animationFrame = requestAnimationFrame(scrollTowardPointer)
    }

    animationFrame = requestAnimationFrame(scrollTowardPointer)
    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateViewportRect)
    }
  }, [activeDragId, props.sessionListViewportRef])

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const collisions = closestCenter(args)
      const candidate = collisions[0]
      if (!candidate) return collisions

      const currentTargetId = collisionTargetIdRef.current ?? args.active.id
      if (candidate.id === currentTargetId) return collisions
      const currentIndex = sparseList.sessionIndexById.get(String(currentTargetId))
      const candidateIndex = sparseList.sessionIndexById.get(String(candidate.id))
      const candidateRect = args.droppableRects.get(candidate.id)
      if (currentIndex === undefined || candidateIndex === undefined || !candidateRect) {
        collisionTargetIdRef.current = candidate.id
        return collisions
      }

      const dragCenterY = args.collisionRect.top + args.collisionRect.height / 2
      if (
        shouldSwitchReorderTarget({
          currentIndex,
          candidateIndex,
          dragCenterY,
          candidateTop: candidateRect.top,
          candidateBottom: candidateRect.bottom,
        })
      ) {
        collisionTargetIdRef.current = candidate.id
        return collisions
      }

      const currentCollisionIndex = collisions.findIndex((collision) => collision.id === currentTargetId)
      if (currentCollisionIndex <= 0) return collisions
      const currentCollision = collisions[currentCollisionIndex]
      return [currentCollision, ...collisions.filter((_, index) => index !== currentCollisionIndex)]
    },
    [sparseList.sessionIndexById]
  )
  const onDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id)
    const pointerY = getPointerClientY(event.activatorEvent)
    collisionTargetIdRef.current = event.active.id
    previewTargetIdRef.current = activeId
    dragDetachedRef.current = false
    dragDirectionRef.current = 0
    currentPointerYRef.current = pointerY
    lastDragDeltaYRef.current = 0
    const shouldEnterReordering = isSmallScreen && !isReordering
    // Capacitor can dispatch haptics before React paints a batched state update.
    // Commit the visual mode first so feedback and mode entry are perceived as
    // one action.
    flushSync(() => {
      setActiveDragId(activeId)
      setPreviewTargetId(activeId)
      setDragDetached(false)
      setDragDirection(0)
      if (shouldEnterReordering) {
        setIsReordering(true)
      }
    })
    if (shouldEnterReordering) {
      if (platform.type === 'mobile') {
        void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
          navigator.vibrate?.(10)
        })
      }
    }
  }
  const onDragMove = (event: DragMoveEvent) => {
    const deltaY = event.delta.y
    lastDragDeltaYRef.current = deltaY
    const nextDirection: -1 | 0 | 1 = deltaY > 0 ? 1 : deltaY < 0 ? -1 : 0
    updateDragDirection(nextDirection)
    const activeId = String(event.active.id)
    updateDragDetached(
      Math.abs(deltaY) >= REORDER_DETACH_DISTANCE_PX ||
        (previewTargetIdRef.current !== null && previewTargetIdRef.current !== activeId)
    )
  }
  const onDragOver = (event: DragOverEvent) => {
    const activeId = String(event.active.id)
    const nextTargetId = event.over ? String(event.over.id) : activeId
    if (previewTargetIdRef.current !== nextTargetId) {
      previewTargetIdRef.current = nextTargetId
      setPreviewTargetId(nextTargetId)
    }
    updateDragDetached(Math.abs(lastDragDeltaYRef.current) >= REORDER_DETACH_DISTANCE_PX || nextTargetId !== activeId)

    const activeIndex = sparseList.sessionIndexById.get(activeId)
    const targetIndex = sparseList.sessionIndexById.get(nextTargetId)
    if (activeIndex !== undefined && targetIndex !== undefined && targetIndex !== activeIndex) {
      updateDragDirection(targetIndex > activeIndex ? 1 : -1)
    }
  }
  const resetDragVisuals = useCallback(() => {
    collisionTargetIdRef.current = null
    previewTargetIdRef.current = null
    dragDetachedRef.current = false
    dragDirectionRef.current = 0
    currentPointerYRef.current = null
    lastDragDeltaYRef.current = 0
    setActiveDragId(null)
    setPreviewTargetId(null)
    setDragDetached(false)
    setDragDirection(0)
  }, [])
  const onDragEnd = async (event: DragEndEvent) => {
    lastDragFinishedAtRef.current = Date.now()
    if (!event.over) {
      resetDragVisuals()
      return
    }
    const activeId = String(event.active.id)
    const overId = String(event.over.id)
    if (activeId !== overId) {
      const oldIndex = sparseList.sessionIndexById.get(activeId)
      const newIndex = sparseList.sessionIndexById.get(overId)
      const activeSession = sortedSessions.find((session) => session.id === activeId)
      const overSession = sortedSessions.find((session) => session.id === overId)
      if (
        oldIndex === undefined ||
        newIndex === undefined ||
        !activeSession ||
        !overSession ||
        !areSessionsInSamePinGroup(activeSession, overSession)
      ) {
        resetDragVisuals()
        return
      }
      const movedOptimistically = sparseList.moveSession(oldIndex, newIndex)
      resetDragVisuals()
      try {
        await reorderSessions(oldIndex, newIndex)
      } catch (error) {
        if (movedOptimistically) {
          sparseList.moveSession(newIndex, oldIndex)
        }
        console.error('Failed to reorder sessions:', error)
      }
      return
    }
    resetDragVisuals()
  }
  const onDragCancel = () => {
    lastDragFinishedAtRef.current = Date.now()
    resetDragVisuals()
  }
  const onSelectWhileReordering = useCallback(() => {
    if (Date.now() - lastDragFinishedAtRef.current < 250) {
      return false
    }
    setIsReordering(false)
    return true
  }, [setIsReordering])
  useEffect(() => {
    if (!showSidebar && isReordering) {
      resetDragVisuals()
      setIsReordering(false)
    }
  }, [isReordering, resetDragVisuals, setIsReordering, showSidebar])
  const activeDragSession = useMemo(
    () => sortedSessions.find((session) => session.id === activeDragId),
    [activeDragId, sortedSessions]
  )
  const activeSessionIndex = activeDragId ? sparseList.sessionIndexById.get(activeDragId) : undefined
  const previewTargetIndex = previewTargetId ? sparseList.sessionIndexById.get(previewTargetId) : undefined
  const previewTargetSession = previewTargetId
    ? sortedSessions.find((session) => session.id === previewTargetId)
    : undefined
  const hasValidPreviewTarget =
    activeDragSession && previewTargetSession
      ? areSessionsInSamePinGroup(activeDragSession, previewTargetSession)
      : false
  const insertionTargetId =
    dragDetached && activeDragId
      ? previewTargetId !== activeDragId && hasValidPreviewTarget
        ? previewTargetId
        : dragDirection !== 0
          ? activeDragId
          : null
      : null
  const insertionEdge: 'top' | 'bottom' | null =
    !insertionTargetId || dragDirection === 0
      ? null
      : previewTargetIndex !== undefined &&
          activeSessionIndex !== undefined &&
          previewTargetIndex !== activeSessionIndex
        ? previewTargetIndex > activeSessionIndex
          ? 'bottom'
          : 'top'
        : dragDirection > 0
          ? 'bottom'
          : 'top'
  const sortableSessionIds = useMemo(() => sortedSessions.map((session) => session.id), [sortedSessions])
  const visualActiveDragId = isSmallScreen ? mobileReorder.activeDragId : activeDragId
  const visualActiveDragSession = isSmallScreen ? mobileReorder.activeSession : activeDragSession
  const visualActiveSessionIndex = isSmallScreen ? mobileReorder.activeSessionIndex : activeSessionIndex
  const visualActiveDisplayIndex =
    visualActiveSessionIndex === null || visualActiveSessionIndex === undefined
      ? null
      : sessionIndexToDisplayIndex(visualActiveSessionIndex, sparseList.pinnedCount)
  const visualDragDetached = isSmallScreen ? mobileReorder.dragDetached : dragDetached
  const visualPlacementTargetDisplayIndex = mobileReorder.placementPreview
    ? sessionIndexToDisplayIndex(mobileReorder.placementPreview.targetIndex, sparseList.pinnedCount)
    : null
  const routerState = useRouterState()

  return (
    <DndContext
      autoScroll={false}
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {!sparseList.isInitializing ? (
        <SortableContext items={isSmallScreen ? [] : sortableSessionIds} strategy={stationarySortingStrategy}>
          <div className="flex min-h-0 flex-1" data-sidebar-swipe-ignore onTouchStartCapture={claimTouchForSessionList}>
            <Virtuoso
              ref={virtuosoRef}
              fixedItemHeight={SESSION_LIST_ITEM_HEIGHT}
              style={{
                flex: 1,
                minHeight: 0,
                ...(platform.type === 'web'
                  ? {
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      WebkitTouchCallout: 'none',
                    }
                  : {}),
              }}
              totalCount={sparseList.displayCount}
              increaseViewportBy={{
                top: SESSION_LIST_RENDER_AHEAD_PX,
                bottom: SESSION_LIST_RENDER_AHEAD_PX,
              }}
              minOverscanItemCount={{
                top: SESSION_LIST_MIN_OVERSCAN_ITEMS,
                bottom: SESSION_LIST_MIN_OVERSCAN_ITEMS,
              }}
              computeItemKey={(displayIndex) => {
                const slot = sparseList.getSlot(displayIndex)
                if (!slot) return `empty:${displayIndex}`
                if (slot.type === 'section') return slot.id
                return slot.session?.id ?? `session-slot:${slot.sessionIndex}`
              }}
              scrollerRef={(ref) => {
                if (ref instanceof HTMLDivElement) {
                  props.sessionListViewportRef.current = ref
                }
              }}
              rangeChanged={sparseList.onRangeChanged}
              itemContent={(displayIndex) => {
                const visualOffsetY = getSessionReorderVisualOffset({
                  displayIndex,
                  activeDisplayIndex: visualActiveDisplayIndex,
                  dragDetached: visualDragDetached,
                  placementTargetDisplayIndex: visualPlacementTargetDisplayIndex,
                  placementEdge: mobileReorder.placementPreview?.edge ?? null,
                  placementKind: mobileReorder.placementPreview?.kind ?? null,
                  itemHeight: SESSION_LIST_ITEM_HEIGHT,
                })
                const slot = sparseList.getSlot(displayIndex)
                if (!slot) {
                  return (
                    <SessionListVisualRow offsetY={visualOffsetY}>
                      <SessionListPlaceholder />
                    </SessionListVisualRow>
                  )
                }
                if (slot.type === 'section') {
                  return (
                    <SessionListVisualRow offsetY={visualOffsetY}>
                      <Flex h={SESSION_LIST_ITEM_HEIGHT} align="flex-end" px="md" pb={6}>
                        <Text size="xs" fw={600} c="chatbox-tertiary">
                          {t(slot.label)}
                        </Text>
                      </Flex>
                    </SessionListVisualRow>
                  )
                }
                if (!slot.session) {
                  return (
                    <SessionListVisualRow offsetY={visualOffsetY}>
                      <SessionListPlaceholder />
                    </SessionListVisualRow>
                  )
                }

                const sessionItem = (
                  <SessionItem
                    selected={routerState.location.pathname === `/session/${slot.session.id}`}
                    session={slot.session}
                    isReordering={Boolean(isSmallScreen && isReordering)}
                    onStartReordering={() => setIsReordering(true)}
                    onSelectWhileReordering={
                      isSmallScreen ? mobileReorder.onSelectWhileReordering : onSelectWhileReordering
                    }
                  />
                )

                if (isSmallScreen) {
                  return (
                    <MobileReorderItem
                      session={slot.session}
                      sessionIndex={slot.sessionIndex}
                      visualOffsetY={visualOffsetY}
                      isDragging={slot.session.id === visualActiveDragId}
                      insertionEdge={
                        !mobileReorder.placementPreview && slot.sessionIndex === mobileReorder.targetIndex
                          ? mobileReorder.insertionEdge
                          : null
                      }
                      showUnpinPrompt={slot.session.id === mobileReorder.unpinPromptId}
                      onPointerDown={mobileReorder.onPointerDown}
                      onTouchStart={mobileReorder.onTouchStart}
                      onConfirmUnpin={() => void mobileReorder.confirmUnpin()}
                      onDismissUnpin={mobileReorder.dismissUnpinPrompt}
                    >
                      {sessionItem}
                    </MobileReorderItem>
                  )
                }

                return (
                  <SortableItem
                    id={slot.session.id}
                    visualOffsetY={visualOffsetY}
                    insertionEdge={slot.session.id === insertionTargetId ? insertionEdge : null}
                  >
                    {sessionItem}
                  </SortableItem>
                )
              }}
            />
          </div>
          {typeof document !== 'undefined' && isSmallScreen && mobileReorder.activeSessionIndex !== null ? (
            <MobileSessionPlacementLayer
              preview={mobileReorder.placementPreview}
              viewportRef={props.sessionListViewportRef}
            />
          ) : null}
          {typeof document !== 'undefined' && isSmallScreen && visualActiveDragSession && mobileReorder.overlayOrigin
            ? createPortal(
                <div
                  ref={mobileReorder.overlayRef}
                  className="mobile-session-manual-overlay pointer-events-none"
                  style={{
                    left: mobileReorder.overlayOrigin.left,
                    top: mobileReorder.overlayOrigin.top,
                    width: mobileReorder.overlayOrigin.width,
                  }}
                >
                  <div className="mobile-session-drag-overlay">
                    <SessionItem
                      selected={routerState.location.pathname === `/session/${visualActiveDragSession.id}`}
                      session={visualActiveDragSession}
                      isReordering
                    />
                  </div>
                </div>,
                document.body
              )
            : null}
          {typeof document !== 'undefined' && !isSmallScreen
            ? createPortal(
                <DragOverlay zIndex={1400}>
                  {visualActiveDragSession ? (
                    <div className="mobile-session-drag-overlay pointer-events-none">
                      <SessionItem
                        selected={routerState.location.pathname === `/session/${visualActiveDragSession.id}`}
                        session={visualActiveDragSession}
                        isReordering={Boolean(isSmallScreen && isReordering)}
                      />
                    </div>
                  ) : null}
                </DragOverlay>,
                document.body
              )
            : null}
        </SortableContext>
      ) : (
        <SessionListLoadingFooter />
      )}
    </DndContext>
  )
}

function SessionListVisualRow(props: { children: React.ReactNode; offsetY: number }) {
  return (
    <div
      className="mobile-session-reorder-row"
      style={{ transform: props.offsetY === 0 ? undefined : `translate3d(0, ${props.offsetY}px, 0)` }}
    >
      {props.children}
    </div>
  )
}

interface PlacementGeometry {
  viewportLeft: number
  viewportTop: number
  viewportWidth: number
  viewportHeight: number
  frameLeft: number
  frameTop: number
  frameWidth: number
  frameHeight: number
}

function placementGeometryEquals(previous: PlacementGeometry | null, next: PlacementGeometry): boolean {
  if (!previous) return false
  return (
    Math.abs(previous.viewportLeft - next.viewportLeft) < 0.25 &&
    Math.abs(previous.viewportTop - next.viewportTop) < 0.25 &&
    Math.abs(previous.viewportWidth - next.viewportWidth) < 0.25 &&
    Math.abs(previous.viewportHeight - next.viewportHeight) < 0.25 &&
    Math.abs(previous.frameLeft - next.frameLeft) < 0.25 &&
    Math.abs(previous.frameTop - next.frameTop) < 0.25 &&
    Math.abs(previous.frameWidth - next.frameWidth) < 0.25 &&
    Math.abs(previous.frameHeight - next.frameHeight) < 0.25
  )
}

interface PlacementLayerVisualState {
  previewKey: string | null
  geometry: PlacementGeometry | null
  visible: boolean
}

function MobileSessionPlacementLayer(props: {
  preview: { key: string; targetIndex: number } | null
  viewportRef: MutableRefObject<HTMLDivElement | null>
}) {
  const [visualState, setVisualState] = useState<PlacementLayerVisualState>({
    previewKey: null,
    geometry: null,
    visible: false,
  })
  const updateFrameRef = useRef<number | null>(null)
  const revealFrameRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (revealFrameRef.current !== null) {
      cancelAnimationFrame(revealFrameRef.current)
      revealFrameRef.current = null
    }
    if (!props.preview) {
      setVisualState((previous) => (previous.visible ? { ...previous, visible: false } : previous))
      return
    }

    const viewport = props.viewportRef.current
    if (!viewport) {
      setVisualState((previous) => ({ ...previous, visible: false }))
      return
    }

    const previewKey = props.preview.key
    const targetIndex = props.preview.targetIndex
    const findTargetRow = () =>
      viewport.querySelector<HTMLElement>(`[data-mobile-reorder-session-index="${targetIndex}"]`)

    const updateGeometry = () => {
      updateFrameRef.current = null
      const targetRow = findTargetRow()
      if (!targetRow) {
        setVisualState((previous) => (previous.previewKey === previewKey ? { ...previous, visible: false } : previous))
        return
      }

      const viewportRect = viewport.getBoundingClientRect()
      const rowRect = targetRow.getBoundingClientRect()
      const nextGeometry: PlacementGeometry = {
        viewportLeft: viewportRect.left,
        viewportTop: viewportRect.top,
        viewportWidth: viewportRect.width,
        viewportHeight: viewportRect.height,
        frameLeft: rowRect.left - viewportRect.left + 10,
        frameTop: rowRect.top - viewportRect.top + 4,
        frameWidth: Math.max(0, rowRect.width - 20),
        frameHeight: Math.max(0, rowRect.height - 8),
      }
      setVisualState((previous) => {
        if (previous.previewKey !== previewKey) {
          return { previewKey, geometry: nextGeometry, visible: false }
        }
        return placementGeometryEquals(previous.geometry, nextGeometry)
          ? previous
          : { ...previous, geometry: nextGeometry }
      })
    }

    const scheduleUpdate = () => {
      if (updateFrameRef.current !== null) return
      updateFrameRef.current = requestAnimationFrame(updateGeometry)
    }

    updateGeometry()
    revealFrameRef.current = requestAnimationFrame(() => {
      revealFrameRef.current = null
      setVisualState((previous) =>
        previous.previewKey === previewKey && previous.geometry ? { ...previous, visible: true } : previous
      )
    })
    viewport.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            scheduleUpdate()
          })
    resizeObserver?.observe(viewport)
    const targetRow = findTargetRow()
    if (targetRow) resizeObserver?.observe(targetRow)

    return () => {
      viewport.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      resizeObserver?.disconnect()
      if (updateFrameRef.current !== null) {
        cancelAnimationFrame(updateFrameRef.current)
        updateFrameRef.current = null
      }
      if (revealFrameRef.current !== null) {
        cancelAnimationFrame(revealFrameRef.current)
        revealFrameRef.current = null
      }
    }
  }, [props.preview, props.viewportRef])

  const geometry = visualState.geometry
  if (!geometry || typeof document === 'undefined') return null
  return createPortal(
    <div
      className="mobile-session-placement-layer"
      data-visible={visualState.visible}
      style={{
        left: geometry.viewportLeft,
        top: geometry.viewportTop,
        width: geometry.viewportWidth,
        height: geometry.viewportHeight,
      }}
      aria-hidden
    >
      <div
        className="mobile-session-placement-frame"
        style={{
          left: geometry.frameLeft,
          top: geometry.frameTop,
          width: geometry.frameWidth,
          height: geometry.frameHeight,
        }}
      />
    </div>,
    document.body
  )
}

function MobileReorderItem(props: {
  session: SessionMetaRecord
  sessionIndex: number
  children: React.ReactNode
  visualOffsetY: number
  isDragging: boolean
  insertionEdge: 'top' | 'bottom' | null
  showUnpinPrompt: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, session: SessionMetaRecord, sessionIndex: number) => void
  onTouchStart: (event: ReactTouchEvent<HTMLDivElement>, session: SessionMetaRecord, sessionIndex: number) => void
  onConfirmUnpin: () => void
  onDismissUnpin: () => void
}) {
  const { t } = useTranslation()
  const row = (
    <div
      className="relative"
      data-mobile-reorder-session-index={props.sessionIndex}
      style={{ height: SESSION_LIST_ITEM_HEIGHT }}
      onPointerDown={(event) => props.onPointerDown(event, props.session, props.sessionIndex)}
      onTouchStart={(event) => props.onTouchStart(event, props.session, props.sessionIndex)}
    >
      <div
        className="mobile-session-reorder-row"
        style={{
          transform: props.visualOffsetY === 0 ? undefined : `translate3d(0, ${props.visualOffsetY}px, 0)`,
        }}
      >
        <div style={{ opacity: props.isDragging ? 0 : undefined }}>{props.children}</div>
        {props.insertionEdge && (
          <div className="mobile-session-reorder-insertion" data-edge={props.insertionEdge} aria-hidden />
        )}
      </div>
    </div>
  )
  if (!props.showUnpinPrompt) return row

  return (
    <Popover
      opened={props.showUnpinPrompt}
      onChange={(opened) => {
        if (!opened) props.onDismissUnpin()
      }}
      position="right"
      withArrow
      withinPortal
      shadow="md"
    >
      <Popover.Target>{row}</Popover.Target>
      <Popover.Dropdown className="mobile-session-unpin-prompt" onPointerDown={(event) => event.stopPropagation()}>
        <Stack gap={8}>
          <Text size="sm" fw={500}>
            {t('Unpin this conversation?')}
          </Text>
          <Flex justify="flex-end" gap={6}>
            <Button variant="subtle" size="compact-xs" onClick={props.onDismissUnpin}>
              {t('Cancel')}
            </Button>
            <Button size="compact-xs" onClick={props.onConfirmUnpin}>
              {t('Unpin')}
            </Button>
          </Flex>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

function SortableItem(props: {
  id: string
  children?: React.ReactNode
  disabled?: boolean
  visualOffsetY?: number
  insertionEdge?: 'top' | 'bottom' | null
}) {
  const { id, children, disabled = false, visualOffsetY = 0, insertionEdge = null } = props
  const { attributes, isDragging, listeners, setNodeRef } = useSortable({
    id,
    disabled,
  })
  const style: CSSProperties = {
    height: SESSION_LIST_ITEM_HEIGHT,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative"
      {...(!disabled ? attributes : {})}
      {...(!disabled ? listeners : {})}
    >
      <div
        className="mobile-session-reorder-row"
        style={{ transform: visualOffsetY === 0 ? undefined : `translate3d(0, ${visualOffsetY}px, 0)` }}
      >
        <div style={{ opacity: isDragging ? 0 : undefined }}>{children}</div>
        {insertionEdge && <div className="mobile-session-reorder-insertion" data-edge={insertionEdge} aria-hidden />}
      </div>
    </div>
  )
}
