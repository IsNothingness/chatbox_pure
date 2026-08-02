import type { SessionMetaPage, SessionMetaRecord } from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ListRange } from 'react-virtuoso'
import { getVisibleSessionMetaIndex, listSessionsMetaPage, useSessionListRevision } from '@/stores/chatStore'
import {
  COLD_ZONE_DISTANCE,
  displayRangeToSessionRange,
  FULL_LOAD_THRESHOLD,
  getPageStartsForRange,
  getPrefetchRange,
  getSessionListDisplayCount,
  getSessionListSlot,
  moveItemInPagedCache,
  type ScrollDirection,
  SESSION_PAGE_SIZE,
  type SessionRange,
  shouldEvictColdPage,
} from './session-list-window'

const COLD_SWEEP_INTERVAL_MS = 5_000
const SCROLL_IDLE_SWEEP_DELAY_MS = 1_500
const SCROLL_ACTIVE_EVICTION_GRACE_MS = 1_200
const PREFETCH_SCHEDULE_DELAY_MS = 24
const PREFETCH_WORKER_COUNT = 2
const MAX_CACHED_PAGES = 20

type PageLoadKind = 'visible' | 'prefetch'

interface PageUsage {
  loadedAt: number
  lastVisibleAt?: number
}

interface ScrollMotion {
  lastCenter: number
  lastAt: number
  direction: ScrollDirection
  speedItemsPerSecond: number
}

export interface LoadedSessionEntry {
  index: number
  session: SessionMetaRecord
}

export interface SparseSessionList {
  total: number
  displayCount: number
  pinnedCount: number
  isInitializing: boolean
  loadedEntries: LoadedSessionEntry[]
  sessionIndexById: Map<string, number>
  getSlot: (
    displayIndex: number
  ) =>
    | { type: 'section'; id: string; label: 'Pinned' | 'Chats' }
    | { type: 'session'; sessionIndex: number; session?: SessionMetaRecord }
    | null
  onRangeChanged: (range: ListRange) => void
  ensureSessionLoaded: (sessionId: string) => Promise<number | null>
  moveSession: (oldIndex: number, newIndex: number) => boolean
}

export function useSparseSessionList(options: { pauseEviction: boolean }): SparseSessionList {
  const sessionListRevision = useSessionListRevision()
  const pagesRef = useRef(new Map<number, SessionMetaRecord[]>())
  const pageUsageRef = useRef(new Map<number, PageUsage>())
  const inflightRef = useRef(new Map<number, Promise<SessionMetaPage | null>>())
  const generationRef = useRef(0)
  const totalRef = useRef(0)
  const visibleRangeRef = useRef<SessionRange>({ start: 0, end: 0 })
  const motionRef = useRef<ScrollMotion>({
    lastCenter: 0,
    lastAt: 0,
    direction: 0,
    speedItemsPerSecond: 0,
  })
  const idleSweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prefetchScheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prefetchGenerationRef = useRef(0)
  const cachePublishFrameRef = useRef<number | null>(null)
  const hasInitializedRef = useRef(false)
  const [cacheVersion, setCacheVersion] = useState(0)
  const [total, setTotal] = useState(0)
  const [pinnedCount, setPinnedCount] = useState(0)
  const [isInitializing, setIsInitializing] = useState(true)

  const publishCacheChange = useCallback(() => {
    if (cachePublishFrameRef.current !== null) return
    cachePublishFrameRef.current = requestAnimationFrame(() => {
      cachePublishFrameRef.current = null
      setCacheVersion((version) => version + 1)
    })
  }, [])

  const publishCacheChangeNow = useCallback(() => {
    if (cachePublishFrameRef.current !== null) {
      cancelAnimationFrame(cachePublishFrameRef.current)
      cachePublishFrameRef.current = null
    }
    setCacheVersion((version) => version + 1)
  }, [])

  const requestPage = useCallback(
    async (pageStart: number, kind: PageLoadKind, force = false): Promise<SessionMetaPage | null> => {
      const inflight = inflightRef.current.get(pageStart)
      if (inflight) {
        const page = await inflight
        if (page && kind === 'visible') {
          const usage = pageUsageRef.current.get(pageStart)
          if (usage) usage.lastVisibleAt = Date.now()
        }
        return page
      }

      const existing = pagesRef.current.get(pageStart)
      if (existing && !force) {
        if (kind === 'visible') {
          const usage = pageUsageRef.current.get(pageStart)
          if (usage) usage.lastVisibleAt = Date.now()
        }
        return {
          items: existing,
          total: totalRef.current,
          nextCursor: pageStart + existing.length < totalRef.current ? pageStart + existing.length : null,
        }
      }

      const generation = generationRef.current
      const request = listSessionsMetaPage(pageStart, SESSION_PAGE_SIZE)
        .then((page) => {
          if (generation !== generationRef.current) return null
          const now = Date.now()
          pagesRef.current.set(pageStart, page.items)
          pageUsageRef.current.set(pageStart, {
            loadedAt: now,
            lastVisibleAt: kind === 'visible' ? now : undefined,
          })
          totalRef.current = page.total
          setTotal(page.total)
          publishCacheChange()
          return page
        })
        .catch((error) => {
          console.error('Failed to preload session list page:', pageStart, error)
          return null
        })
        .finally(() => {
          if (inflightRef.current.get(pageStart) === request) {
            inflightRef.current.delete(pageStart)
          }
        })
      inflightRef.current.set(pageStart, request)
      return request
    },
    [publishCacheChange]
  )

  useEffect(() => {
    void sessionListRevision
    const isBackgroundRefresh = hasInitializedRef.current
    const cachedPageStarts = [...pagesRef.current.keys()]
    generationRef.current += 1
    inflightRef.current.clear()
    prefetchGenerationRef.current += 1
    if (prefetchScheduleTimerRef.current) {
      clearTimeout(prefetchScheduleTimerRef.current)
      prefetchScheduleTimerRef.current = null
    }
    if (!isBackgroundRefresh) {
      pagesRef.current.clear()
      pageUsageRef.current.clear()
      totalRef.current = 0
      visibleRangeRef.current = { start: 0, end: 0 }
      motionRef.current = {
        lastCenter: 0,
        lastAt: 0,
        direction: 0,
        speedItemsPerSecond: 0,
      }
      setTotal(0)
      setPinnedCount(0)
      setIsInitializing(true)
    }
    publishCacheChange()

    const generation = generationRef.current
    const initialize = async () => {
      const refreshPageStarts = isBackgroundRefresh ? [...new Set([0, ...cachedPageStarts])] : [0]
      const refreshRequests = refreshPageStarts.map((pageStart) =>
        requestPage(pageStart, pageStart === 0 ? 'visible' : 'prefetch', isBackgroundRefresh)
      )
      const firstPage = await refreshRequests[0]
      if (!firstPage || generation !== generationRef.current) return

      if (firstPage.total <= FULL_LOAD_THRESHOLD) {
        const allPageStarts = getPageStartsForRange(
          { start: 0, end: Math.max(0, firstPage.total - 1) },
          SESSION_PAGE_SIZE
        )
        await Promise.all(allPageStarts.slice(1).map((pageStart) => requestPage(pageStart, 'prefetch')))
      } else if (isBackgroundRefresh) {
        await Promise.all(refreshRequests.slice(1))
      }
      if (generation !== generationRef.current) return

      let nextPageStart = 0
      let discoveredPinnedCount = 0
      while (nextPageStart < firstPage.total) {
        const page = await requestPage(nextPageStart, nextPageStart === 0 ? 'visible' : 'prefetch')
        if (!page || generation !== generationRef.current || page.items.length === 0) break
        const firstUnpinnedIndex = page.items.findIndex((session) => !session.starred)
        if (firstUnpinnedIndex >= 0) {
          discoveredPinnedCount = nextPageStart + firstUnpinnedIndex
          break
        }
        discoveredPinnedCount = nextPageStart + page.items.length
        nextPageStart += page.items.length
      }
      if (generation !== generationRef.current) return
      setPinnedCount(Math.min(discoveredPinnedCount, firstPage.total))
      hasInitializedRef.current = true
      setIsInitializing(false)
    }

    void initialize()
    return () => {
      generationRef.current += 1
    }
  }, [publishCacheChange, requestPage, sessionListRevision])

  const sweepColdPages = useCallback(() => {
    if (options.pauseEviction || totalRef.current <= FULL_LOAD_THRESHOLD) return
    const now = Date.now()
    const visible = visibleRangeRef.current
    const motion = motionRef.current
    const motionIdleMs = motion.lastAt > 0 ? performance.now() - motion.lastAt : Number.POSITIVE_INFINITY
    if (motionIdleMs < SCROLL_ACTIVE_EVICTION_GRACE_MS) return
    const effectiveSpeed = motionIdleMs < 1_000 ? motion.speedItemsPerSecond : 0
    const removable: Array<{ pageStart: number; distance: number }> = []

    for (const [pageStart] of pagesRef.current) {
      const usage = pageUsageRef.current.get(pageStart)
      if (!usage) continue
      const shouldEvict = shouldEvictColdPage({
        pageStart,
        pageSize: SESSION_PAGE_SIZE,
        visible,
        direction: motion.direction,
        speedItemsPerSecond: effectiveSpeed,
        loadedAt: usage.loadedAt,
        lastVisibleAt: usage.lastVisibleAt,
        now,
      })
      const pageEnd = pageStart + SESSION_PAGE_SIZE - 1
      const distance =
        pageEnd < visible.start ? visible.start - pageEnd : pageStart > visible.end ? pageStart - visible.end : 0
      if (shouldEvict || (pagesRef.current.size > MAX_CACHED_PAGES && distance > COLD_ZONE_DISTANCE)) {
        removable.push({ pageStart, distance })
      }
    }

    removable.sort((a, b) => b.distance - a.distance)
    let changed = false
    for (const { pageStart } of removable) {
      if (pagesRef.current.size <= MAX_CACHED_PAGES) {
        const usage = pageUsageRef.current.get(pageStart)
        if (
          usage &&
          !shouldEvictColdPage({
            pageStart,
            pageSize: SESSION_PAGE_SIZE,
            visible,
            direction: motion.direction,
            speedItemsPerSecond: effectiveSpeed,
            loadedAt: usage.loadedAt,
            lastVisibleAt: usage.lastVisibleAt,
            now,
          })
        ) {
          continue
        }
      }
      pagesRef.current.delete(pageStart)
      pageUsageRef.current.delete(pageStart)
      changed = true
    }
    if (changed) publishCacheChange()
  }, [options.pauseEviction, publishCacheChange])

  useEffect(() => {
    const interval = setInterval(sweepColdPages, COLD_SWEEP_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [sweepColdPages])

  useEffect(
    () => () => {
      if (idleSweepTimerRef.current) clearTimeout(idleSweepTimerRef.current)
      if (prefetchScheduleTimerRef.current) clearTimeout(prefetchScheduleTimerRef.current)
      prefetchGenerationRef.current += 1
      if (cachePublishFrameRef.current !== null) {
        cancelAnimationFrame(cachePublishFrameRef.current)
        cachePublishFrameRef.current = null
      }
    },
    []
  )

  const onRangeChanged = useCallback(
    (range: ListRange) => {
      if (isInitializing || total <= 0) return
      const visible = displayRangeToSessionRange(range.startIndex, range.endIndex, total, pinnedCount)
      if (!visible) return

      const now = performance.now()
      const center = (visible.start + visible.end) / 2
      const previousMotion = motionRef.current
      const elapsedSeconds = previousMotion.lastAt > 0 ? Math.max(0.016, (now - previousMotion.lastAt) / 1_000) : 0
      const delta = center - previousMotion.lastCenter
      const instantSpeed = elapsedSeconds > 0 ? Math.abs(delta) / elapsedSeconds : 0
      const direction: ScrollDirection = delta > 0 ? 1 : delta < 0 ? -1 : previousMotion.direction
      const speedItemsPerSecond =
        previousMotion.lastAt > 0 ? previousMotion.speedItemsPerSecond * 0.6 + instantSpeed * 0.4 : 0
      motionRef.current = {
        lastCenter: center,
        lastAt: now,
        direction,
        speedItemsPerSecond,
      }
      visibleRangeRef.current = visible

      for (const pageStart of getPageStartsForRange(visible, SESSION_PAGE_SIZE)) {
        const usage = pageUsageRef.current.get(pageStart)
        if (usage) usage.lastVisibleAt = Date.now()
        void requestPage(pageStart, 'visible')
      }

      const prefetchRange = getPrefetchRange(visible, total, direction, speedItemsPerSecond)
      const visibleCenter = (visible.start + visible.end) / 2
      const pageStarts = getPageStartsForRange(prefetchRange, SESSION_PAGE_SIZE).sort(
        (a, b) => Math.abs(a - visibleCenter) - Math.abs(b - visibleCenter)
      )
      if (prefetchScheduleTimerRef.current) {
        clearTimeout(prefetchScheduleTimerRef.current)
      }
      const prefetchGeneration = ++prefetchGenerationRef.current
      prefetchScheduleTimerRef.current = setTimeout(() => {
        prefetchScheduleTimerRef.current = null
        const runWorker = async (workerIndex: number) => {
          for (let index = workerIndex; index < pageStarts.length; index += PREFETCH_WORKER_COUNT) {
            if (prefetchGeneration !== prefetchGenerationRef.current) return
            await requestPage(pageStarts[index], 'prefetch')
          }
        }
        void Promise.all(Array.from({ length: PREFETCH_WORKER_COUNT }, (_, workerIndex) => runWorker(workerIndex)))
      }, PREFETCH_SCHEDULE_DELAY_MS)

      if (idleSweepTimerRef.current) clearTimeout(idleSweepTimerRef.current)
      idleSweepTimerRef.current = setTimeout(sweepColdPages, SCROLL_IDLE_SWEEP_DELAY_MS)
    },
    [isInitializing, pinnedCount, requestPage, sweepColdPages, total]
  )

  const loadedEntries = useMemo(() => {
    void cacheVersion
    const entries: LoadedSessionEntry[] = []
    const pageStarts = [...pagesRef.current.keys()].sort((a, b) => a - b)
    for (const pageStart of pageStarts) {
      const page = pagesRef.current.get(pageStart) ?? []
      for (let indexInPage = 0; indexInPage < page.length; indexInPage += 1) {
        const index = pageStart + indexInPage
        if (index < total) entries.push({ index, session: page[indexInPage] })
      }
    }
    return entries
  }, [cacheVersion, total])

  const sessionIndexById = useMemo(
    () => new Map(loadedEntries.map((entry) => [entry.session.id, entry.index])),
    [loadedEntries]
  )

  const getSlot = useCallback(
    (displayIndex: number) => {
      void cacheVersion
      const slot = getSessionListSlot(displayIndex, total, pinnedCount)
      if (!slot || slot.type === 'section') return slot
      const pageStart = Math.floor(slot.sessionIndex / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE
      return {
        ...slot,
        session: pagesRef.current.get(pageStart)?.[slot.sessionIndex - pageStart],
      }
    },
    [cacheVersion, pinnedCount, total]
  )

  const moveSession = useCallback(
    (oldIndex: number, newIndex: number) => {
      if (!moveItemInPagedCache(pagesRef.current, oldIndex, newIndex)) return false
      publishCacheChangeNow()
      return true
    },
    [publishCacheChangeNow]
  )

  const ensureSessionLoaded = useCallback(
    async (sessionId: string): Promise<number | null> => {
      for (const [pageStart, page] of pagesRef.current) {
        const indexInPage = page.findIndex((session) => session.id === sessionId)
        if (indexInPage >= 0) return pageStart + indexInPage
      }

      const sessionIndex = await getVisibleSessionMetaIndex(sessionId)
      if (sessionIndex === null || sessionIndex < 0 || sessionIndex >= totalRef.current) return null
      const pageStart = Math.floor(sessionIndex / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE
      const page = await requestPage(pageStart, 'visible')
      if (!page) return null
      publishCacheChangeNow()
      return sessionIndex
    },
    [publishCacheChangeNow, requestPage]
  )

  return {
    total,
    displayCount: getSessionListDisplayCount(total, pinnedCount),
    pinnedCount,
    isInitializing,
    loadedEntries,
    sessionIndexById,
    getSlot,
    onRangeChanged,
    ensureSessionLoaded,
    moveSession,
  }
}
