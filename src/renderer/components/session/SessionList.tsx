import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { DragEndEvent } from '@dnd-kit/core'
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
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button, Flex, Text } from '@mantine/core'
import { areSessionsInSamePinGroup } from '@shared/utils/session-sort'
import { IconArrowsMoveVertical, IconLoader2 } from '@tabler/icons-react'
import { useRouterState } from '@tanstack/react-router'
import { type CSSProperties, type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import platform from '@/platform'
import { reorderSessions } from '@/stores/sessionActions'
import { useUIStore } from '@/stores/uiStore'
import SessionItem from './SessionItem'
import { useSparseSessionList } from './useSparseSessionList'

export interface Props {
  sessionListViewportRef: MutableRefObject<HTMLDivElement | null>
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

const SESSION_LIST_RENDER_AHEAD_PX = 1_152
const SESSION_LIST_MIN_OVERSCAN_ITEMS = 24

export default function SessionList(props: Props) {
  const { t } = useTranslation()
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [isReordering, setIsReordering] = useState(false)
  const sparseList = useSparseSessionList({ pauseEviction: isReordering || activeDragId !== null })
  const sortedSessions = useMemo(
    () => sparseList.loadedEntries.map((entry) => entry.session),
    [sparseList.loadedEntries]
  )
  const lastDragFinishedAtRef = useRef(0)
  const isSmallScreen = useIsSmallScreen()
  const showSidebar = useUIStore((state) => state.showSidebar)
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      delay: isReordering ? 500 : 800,
      tolerance: 8,
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
  const onDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
    if (isSmallScreen && !isReordering) {
      setIsReordering(true)
      if (platform.type === 'mobile') {
        void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
          navigator.vibrate?.(10)
        })
      }
    }
  }
  const onDragEnd = async (event: DragEndEvent) => {
    lastDragFinishedAtRef.current = Date.now()
    setActiveDragId(null)
    if (!event.over) {
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
        return
      }
      await reorderSessions(oldIndex, newIndex)
    }
  }
  const onDragCancel = () => {
    lastDragFinishedAtRef.current = Date.now()
    setActiveDragId(null)
  }
  const onSelectWhileReordering = useCallback(() => {
    if (Date.now() - lastDragFinishedAtRef.current < 250) {
      return false
    }
    setIsReordering(false)
    return true
  }, [])
  useEffect(() => {
    if (!showSidebar && isReordering) {
      setActiveDragId(null)
      setIsReordering(false)
    }
  }, [isReordering, showSidebar])
  const activeDragSession = useMemo(
    () => sortedSessions.find((session) => session.id === activeDragId),
    [activeDragId, sortedSessions]
  )
  const sortableSessionIds = useMemo(() => sortedSessions.map((session) => session.id), [sortedSessions])
  const routerState = useRouterState()

  return (
    <DndContext
      modifiers={[restrictToVerticalAxis]}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {!sparseList.isInitializing ? (
        <SortableContext items={sortableSessionIds} strategy={verticalListSortingStrategy}>
          {isSmallScreen && isReordering && (
            <Flex
              align="center"
              justify="space-between"
              mx="xs"
              mb={2}
              px="xs"
              py={6}
              className="rounded-sm bg-chatbox-background-gray-secondary"
            >
              <Flex align="center" gap={6}>
                <IconArrowsMoveVertical size={16} className="text-chatbox-tertiary" />
                <Text size="sm" fw={500} c="chatbox-secondary">
                  {t('Adjust order')}
                </Text>
              </Flex>
              <Button variant="subtle" size="compact-sm" onClick={() => setIsReordering(false)}>
                {t('Done')}
              </Button>
            </Flex>
          )}
          <Virtuoso
            defaultItemHeight={48}
            style={{
              flex: 1,
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
              const slot = sparseList.getSlot(displayIndex)
              if (!slot) return <SessionListPlaceholder />
              if (slot.type === 'section') {
                return (
                  <Text px="md" pt="sm" pb={4} size="xs" fw={600} c="chatbox-tertiary">
                    {t(slot.label)}
                  </Text>
                )
              }
              if (!slot.session) return <SessionListPlaceholder />

              return (
                <SortableItem id={slot.session.id}>
                  <SessionItem
                    selected={routerState.location.pathname === `/session/${slot.session.id}`}
                    session={slot.session}
                    isReordering={Boolean(isSmallScreen && isReordering)}
                    onStartReordering={() => setIsReordering(true)}
                    onSelectWhileReordering={onSelectWhileReordering}
                  />
                </SortableItem>
              )
            }}
          />
          <DragOverlay>
            {activeDragSession ? (
              <div className="pointer-events-none">
                <SessionItem
                  selected={routerState.location.pathname === `/session/${activeDragSession.id}`}
                  session={activeDragSession}
                  isReordering={Boolean(isSmallScreen && isReordering)}
                />
              </div>
            ) : null}
          </DragOverlay>
        </SortableContext>
      ) : (
        <SessionListLoadingFooter />
      )}
    </DndContext>
  )
}

function SortableItem(props: { id: string; children?: React.ReactNode; disabled?: boolean }) {
  const { id, children, disabled = false } = props
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id,
    disabled,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative"
      {...(!disabled ? attributes : {})}
      {...(!disabled ? listeners : {})}
    >
      {children}
    </div>
  )
}
