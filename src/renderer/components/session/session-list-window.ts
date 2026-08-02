export const SESSION_PAGE_SIZE = 50
export const FULL_LOAD_THRESHOLD = 200
export const COLD_ZONE_DISTANCE = 200
export const PREFETCHED_PAGE_TTL_MS = 10_000
export const VIEWED_PAGE_TTL_MS = 30_000
export const REORDER_SWAP_PENETRATION_RATIO = 0.25
export const REORDER_EDGE_SCROLL_ZONE_PX = 96
export const REORDER_EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND = 1_200

export type ScrollDirection = -1 | 0 | 1

export type SessionListSlot =
  | { type: 'section'; id: 'section:pinned' | 'section:chats'; label: 'Pinned' | 'Chats' }
  | { type: 'session'; sessionIndex: number }

export interface SessionRange {
  start: number
  end: number
}

export type SessionReorderGroup = 'pinned' | 'chats'
export type SessionPlacementPreviewKind = 'source' | 'destination'

export interface SessionReorderTarget {
  targetIndex: number | null
  crossedGroup: boolean
}

export type PlacementPreviewAction = 'clear' | 'keep-confirmed' | 'keep-pending' | 'start-pending'

export function getPlacementPreviewAction(options: {
  currentPreviewKey: string | null
  pendingCandidateKey: string | null
  nextCandidateKey: string | null
  listMoved: boolean
}): PlacementPreviewAction {
  if (options.nextCandidateKey === null) return 'clear'
  if (options.currentPreviewKey === options.nextCandidateKey) return 'keep-confirmed'
  if (options.listMoved) return 'clear'
  if (options.pendingCandidateKey === options.nextCandidateKey) return 'keep-pending'
  return 'start-pending'
}

export function getSessionReorderVisualOffset(options: {
  displayIndex: number
  activeDisplayIndex: number | null
  dragDetached: boolean
  placementTargetDisplayIndex: number | null
  placementEdge: 'top' | 'bottom' | null
  placementKind: SessionPlacementPreviewKind | null
  itemHeight: number
}): number {
  let offset = 0
  if (
    options.dragDetached &&
    options.activeDisplayIndex !== null &&
    options.displayIndex > options.activeDisplayIndex
  ) {
    offset -= options.itemHeight
  }

  if (
    options.placementTargetDisplayIndex === null ||
    options.placementEdge === null ||
    // When the card has reattached to its source, the source row itself is
    // already the single cyan slot. Opening another gap would double it.
    (options.placementKind === 'source' && !options.dragDetached)
  ) {
    return offset
  }

  const followsPlacement =
    options.placementEdge === 'top'
      ? options.displayIndex >= options.placementTargetDisplayIndex
      : options.displayIndex > options.placementTargetDisplayIndex
  return followsPlacement ? offset + options.itemHeight : offset
}

export function isWithinSourcePlacementZone(options: {
  distanceFromSourceCenter: number
  sourceCandidateActive: boolean
  itemHeight: number
}): boolean {
  // Enter while the dragged card's center is anywhere inside its source row.
  // Once the cyan source slot is active, keep a small hysteresis band so
  // normal Android touch jitter cannot repeatedly clear and recreate it.
  const halfZone = options.sourceCandidateActive ? options.itemHeight * 0.625 : options.itemHeight / 2
  return Math.abs(options.distanceFromSourceCenter) <= halfZone
}

export function getSessionListDisplayCount(total: number, pinnedCount: number): number {
  if (total <= 0) return 0
  if (pinnedCount <= 0) return total
  return total + (pinnedCount < total ? 2 : 1)
}

export function getSessionListSlot(displayIndex: number, total: number, pinnedCount: number): SessionListSlot | null {
  if (displayIndex < 0 || displayIndex >= getSessionListDisplayCount(total, pinnedCount)) {
    return null
  }
  if (pinnedCount <= 0) {
    return { type: 'session', sessionIndex: displayIndex }
  }
  if (displayIndex === 0) {
    return { type: 'section', id: 'section:pinned', label: 'Pinned' }
  }
  if (displayIndex <= pinnedCount) {
    return { type: 'session', sessionIndex: displayIndex - 1 }
  }
  if (pinnedCount < total && displayIndex === pinnedCount + 1) {
    return { type: 'section', id: 'section:chats', label: 'Chats' }
  }
  return { type: 'session', sessionIndex: displayIndex - 2 }
}

export function sessionIndexToDisplayIndex(sessionIndex: number, pinnedCount: number): number {
  if (pinnedCount <= 0) return sessionIndex
  return sessionIndex < pinnedCount ? sessionIndex + 1 : sessionIndex + 2
}

export function getSessionReorderTarget(
  displayIndex: number,
  total: number,
  pinnedCount: number,
  group: SessionReorderGroup
): SessionReorderTarget {
  if (total <= 0) return { targetIndex: null, crossedGroup: false }

  const clampedDisplayIndex = Math.max(0, Math.min(getSessionListDisplayCount(total, pinnedCount) - 1, displayIndex))
  if (pinnedCount <= 0) {
    return group === 'chats'
      ? { targetIndex: clampedDisplayIndex, crossedGroup: false }
      : { targetIndex: null, crossedGroup: true }
  }

  if (group === 'pinned') {
    const chatsHeaderIndex = pinnedCount + 1
    if (pinnedCount < total && clampedDisplayIndex >= chatsHeaderIndex) {
      return { targetIndex: null, crossedGroup: true }
    }
    const slot = getSessionListSlot(clampedDisplayIndex, total, pinnedCount)
    return {
      targetIndex: slot?.type === 'session' ? Math.min(slot.sessionIndex, pinnedCount - 1) : 0,
      crossedGroup: false,
    }
  }

  if (clampedDisplayIndex <= pinnedCount) {
    return { targetIndex: null, crossedGroup: true }
  }
  const slot = getSessionListSlot(clampedDisplayIndex, total, pinnedCount)
  return {
    targetIndex: slot?.type === 'session' ? Math.max(slot.sessionIndex, pinnedCount) : pinnedCount,
    crossedGroup: false,
  }
}

export function displayRangeToSessionRange(
  displayStart: number,
  displayEnd: number,
  total: number,
  pinnedCount: number
): SessionRange | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (let displayIndex = displayStart; displayIndex <= displayEnd; displayIndex += 1) {
    const slot = getSessionListSlot(displayIndex, total, pinnedCount)
    if (slot?.type !== 'session') continue
    start = Math.min(start, slot.sessionIndex)
    end = Math.max(end, slot.sessionIndex)
  }
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
}

export function getPrefetchRange(
  visible: SessionRange,
  total: number,
  direction: ScrollDirection,
  speedItemsPerSecond: number
): SessionRange {
  const ahead = speedItemsPerSecond >= 60 ? 400 : speedItemsPerSecond >= 20 ? 200 : 100
  const behind = 50
  const before = direction < 0 ? ahead : direction > 0 ? behind : 100
  const after = direction > 0 ? ahead : direction < 0 ? behind : 100
  return {
    start: Math.max(0, visible.start - before),
    end: Math.min(Math.max(0, total - 1), visible.end + after),
  }
}

export function getPageStartsForRange(range: SessionRange, pageSize = SESSION_PAGE_SIZE): number[] {
  if (range.end < range.start) return []
  const firstPage = Math.floor(range.start / pageSize) * pageSize
  const lastPage = Math.floor(range.end / pageSize) * pageSize
  const starts: number[] = []
  for (let pageStart = firstPage; pageStart <= lastPage; pageStart += pageSize) {
    starts.push(pageStart)
  }
  return starts
}

export function moveItemInPagedCache<T>(
  pages: Map<number, T[]>,
  oldIndex: number,
  newIndex: number,
  pageSize = SESSION_PAGE_SIZE
): boolean {
  if (oldIndex === newIndex) return true
  const start = Math.min(oldIndex, newIndex)
  const end = Math.max(oldIndex, newIndex)
  const items: T[] = []
  for (let index = start; index <= end; index += 1) {
    const pageStart = Math.floor(index / pageSize) * pageSize
    const item = pages.get(pageStart)?.[index - pageStart]
    if (item === undefined) return false
    items.push(item)
  }

  const movedOffset = oldIndex - start
  const targetOffset = newIndex - start
  const [movedItem] = items.splice(movedOffset, 1)
  items.splice(targetOffset, 0, movedItem)
  for (let offset = 0; offset < items.length; offset += 1) {
    const index = start + offset
    const pageStart = Math.floor(index / pageSize) * pageSize
    const page = pages.get(pageStart)
    if (!page) return false
    page[index - pageStart] = items[offset]
  }
  return true
}

export function shouldSwitchReorderTarget(options: {
  currentIndex: number
  candidateIndex: number
  dragCenterY: number
  candidateTop: number
  candidateBottom: number
  penetrationRatio?: number
}): boolean {
  if (options.currentIndex === options.candidateIndex) return true
  const candidateHeight = Math.max(0, options.candidateBottom - options.candidateTop)
  const penetration = candidateHeight * (options.penetrationRatio ?? REORDER_SWAP_PENETRATION_RATIO)
  return options.candidateIndex > options.currentIndex
    ? options.dragCenterY >= options.candidateTop + penetration
    : options.dragCenterY <= options.candidateBottom - penetration
}

export function getReorderEdgeScrollVelocity(options: {
  pointerY: number
  viewportTop: number
  viewportBottom: number
  edgeZone?: number
  maxSpeed?: number
}): number {
  const edgeZone = Math.max(1, options.edgeZone ?? REORDER_EDGE_SCROLL_ZONE_PX)
  const maxSpeed = Math.max(0, options.maxSpeed ?? REORDER_EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND)
  const topProgress = Math.min(1, Math.max(0, (options.viewportTop + edgeZone - options.pointerY) / edgeZone))
  const bottomProgress = Math.min(1, Math.max(0, (options.pointerY - (options.viewportBottom - edgeZone)) / edgeZone))

  if (topProgress === bottomProgress) return 0
  const progress = Math.max(topProgress, bottomProgress)
  const direction = bottomProgress > topProgress ? 1 : -1
  return direction * maxSpeed * progress * progress
}

export interface ColdPageCandidate {
  pageStart: number
  pageSize: number
  visible: SessionRange
  direction: ScrollDirection
  speedItemsPerSecond: number
  loadedAt: number
  lastVisibleAt?: number
  now: number
}

export function shouldEvictColdPage(candidate: ColdPageCandidate): boolean {
  const pageEnd = candidate.pageStart + candidate.pageSize - 1
  const beforeColdZone = pageEnd < candidate.visible.start - COLD_ZONE_DISTANCE
  const afterColdZone = candidate.pageStart > candidate.visible.end + COLD_ZONE_DISTANCE
  if (!beforeColdZone && !afterColdZone) return false

  const movingTowardPage =
    candidate.speedItemsPerSecond >= 20 &&
    ((candidate.direction < 0 && beforeColdZone) || (candidate.direction > 0 && afterColdZone))
  if (movingTowardPage) return false

  const lastRelevantTime = candidate.lastVisibleAt ?? candidate.loadedAt
  const ttl = candidate.lastVisibleAt === undefined ? PREFETCHED_PAGE_TTL_MS : VIEWED_PAGE_TTL_MS
  return candidate.now - lastRelevantTime >= ttl
}
