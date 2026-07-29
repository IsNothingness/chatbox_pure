export const SESSION_PAGE_SIZE = 50
export const FULL_LOAD_THRESHOLD = 200
export const COLD_ZONE_DISTANCE = 200
export const PREFETCHED_PAGE_TTL_MS = 10_000
export const VIEWED_PAGE_TTL_MS = 30_000

export type ScrollDirection = -1 | 0 | 1

export type SessionListSlot =
  | { type: 'section'; id: 'section:pinned' | 'section:chats'; label: 'Pinned' | 'Chats' }
  | { type: 'session'; sessionIndex: number }

export interface SessionRange {
  start: number
  end: number
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
