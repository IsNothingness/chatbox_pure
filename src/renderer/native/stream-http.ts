import { App } from '@capacitor/app'
import { type PluginListenerHandle, registerPlugin } from '@capacitor/core'
import { type StartStreamOptions, StreamHttp } from 'capacitor-stream-http'
import { CHATBOX_BUILD_PLATFORM } from '@/variables'

export type { StartStreamOptions } from 'capacitor-stream-http'
export { StreamHttp }

export type NativeStreamState = 'pending' | 'running' | 'ended' | 'error' | 'cancelled'

export interface NativeStreamTask {
  id: string
  clientRequestId?: string
  sessionId?: string
  messageId?: string
  state: NativeStreamState
  error?: string
  lastSequence: number
  createdAt: number
}

interface NativeStreamChunk {
  sequence: number
  /** Version 2 native transport: untouched response bytes encoded for the Capacitor JSON bridge. */
  chunkBase64?: string
  /** Version 1 compatibility for tests and already-buffered text streams. */
  chunk?: string
}

interface NativeStreamSnapshot extends NativeStreamTask {
  chunks: NativeStreamChunk[]
  hasMore: boolean
}

interface PureStartStreamOptions extends StartStreamOptions {
  id?: string
  keepAlive?: boolean
  notificationTitle?: string
  notificationBody?: string
  notifyWhenComplete?: boolean
  completionNotificationMode?: 'off' | 'silent' | 'normal'
  completionTitle?: string
  completionBody?: string
  clientRequestId?: string
  sessionId?: string
  messageId?: string
}

interface PureStreamEvent {
  id: string
  sequence?: number
  lastSequence?: number
  chunk?: string
  error?: string
}

interface PureStreamHttpPlugin {
  startStream(options: PureStartStreamOptions): Promise<{ id: string }>
  attachStream(options: {
    id: string
    afterSequence: number
    maxChunks?: number
    maxBytes?: number
  }): Promise<NativeStreamSnapshot>
  listStreams(): Promise<{ streams: NativeStreamTask[] }>
  acknowledgeStream(options: { id: string }): Promise<void>
  cancelStream(options: { id: string }): Promise<void>
  debugGenerationLog?(options: { event: string; fields?: Record<string, string | number | boolean> }): Promise<void>
  configureGenerationDebugLogging?(options: { enabled: boolean }): Promise<{ enabled: boolean; forced: boolean }>
  requestNotificationPermission(): Promise<{ granted: boolean }>
  configureNotificationChannels(options: { mode: 'off' | 'silent' | 'normal' }): Promise<void>
  showCompletionNotification(options: { title: string; body: string; mode?: 'silent' | 'normal' }): Promise<void>
  addListener(
    eventName: 'chunk' | 'end' | 'error',
    listenerFunc: (data: PureStreamEvent) => void
  ): Promise<PluginListenerHandle>
}

const PureStreamHttp = registerPlugin<PureStreamHttpPlugin>('PureStreamHttp')
const CompatibleStreamHttp = StreamHttp as unknown as PureStreamHttpPlugin
const READER_FINALIZATION_GRACE_MS = 30_000

interface ActiveNativeStreamReader {
  wake: () => void
  releaseTimer?: ReturnType<typeof setTimeout>
}

const activeNativeStreamReaders = new Map<string, ActiveNativeStreamReader>()

function releaseActiveNativeStreamReader(streamId: string): void {
  const registration = activeNativeStreamReaders.get(streamId)
  if (registration?.releaseTimer) clearTimeout(registration.releaseTimer)
  activeNativeStreamReaders.delete(streamId)
}

export function hasActiveNativeStreamReader(streamId: string): boolean {
  return activeNativeStreamReaders.has(streamId)
}

/**
 * Capacitor/WebView lifecycle events can be delayed or delivered out of order after a
 * notification opens the app. Wake every attached reader from the app-level lifecycle
 * monitor so completed native buffers are drained without requiring the stop button.
 */
export function wakeNativeStreamReaders(): void {
  for (const reader of activeNativeStreamReaders.values()) {
    reader.wake()
  }
}

function createStreamId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `pure-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function requestGenerationNotificationPermission(): Promise<boolean> {
  if (CHATBOX_BUILD_PLATFORM !== 'android') return true
  try {
    return (await PureStreamHttp.requestNotificationPermission()).granted
  } catch (error) {
    console.warn('Failed to request generation notification permission:', error)
    return false
  }
}

export async function configureGenerationNotificationChannels(mode: 'off' | 'silent' | 'normal'): Promise<void> {
  if (CHATBOX_BUILD_PLATFORM !== 'android') return
  try {
    await PureStreamHttp.configureNotificationChannels({ mode })
  } catch (error) {
    console.warn('Failed to configure generation notification channels:', error)
  }
}

export interface GenerationDebugLoggingStatus {
  enabled: boolean
  forced: boolean
}

export async function configureGenerationDebugLogging(enabled: boolean): Promise<GenerationDebugLoggingStatus> {
  if (CHATBOX_BUILD_PLATFORM !== 'android' || !PureStreamHttp.configureGenerationDebugLogging) {
    return { enabled: false, forced: false }
  }
  try {
    return await PureStreamHttp.configureGenerationDebugLogging({ enabled })
  } catch (error) {
    console.warn('Failed to configure generation diagnostic logging:', error)
    return { enabled: false, forced: false }
  }
}

export async function showGenerationCompleteNotification(
  title: string,
  body: string,
  mode: 'silent' | 'normal' = 'silent'
): Promise<void> {
  if (CHATBOX_BUILD_PLATFORM !== 'android') return
  try {
    await PureStreamHttp.showCompletionNotification({ title, body, mode })
  } catch (error) {
    console.warn('Failed to show generation completion notification:', error)
  }
}

export async function listNativeStreamTasks(): Promise<NativeStreamTask[]> {
  if (CHATBOX_BUILD_PLATFORM !== 'android') return []
  try {
    return (await PureStreamHttp.listStreams()).streams
  } catch (error) {
    console.warn('Failed to list native background streams:', error)
    return []
  }
}

export async function acknowledgeNativeStreams(streamIds: Iterable<string>): Promise<void> {
  if (CHATBOX_BUILD_PLATFORM !== 'android') return
  await Promise.all(
    [...new Set(streamIds)].map(async (id) => {
      try {
        await PureStreamHttp.acknowledgeStream({ id })
      } catch (error) {
        console.warn(`Failed to acknowledge native stream ${id}:`, error)
      } finally {
        releaseActiveNativeStreamReader(id)
      }
    })
  )
}

export async function cancelNativeStream(id: string): Promise<void> {
  if (CHATBOX_BUILD_PLATFORM !== 'android') return
  try {
    await PureStreamHttp.cancelStream({ id })
  } catch (error) {
    console.warn(`Failed to cancel native stream ${id}:`, error)
  }
}

export function writeGenerationDebugLog(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {}
): void {
  if (CHATBOX_BUILD_PLATFORM !== 'android' || !PureStreamHttp.debugGenerationLog) return
  const definedFields = Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
  )
  void PureStreamHttp.debugGenerationLog({ event, fields: definedFields }).catch(() => {
    // Debug diagnostics must never affect generation.
  })
}

interface BackgroundStreamOptions {
  keepAlive: boolean
  notificationTitle: string
  notificationBody: string
  notifyWhenComplete?: boolean
  completionNotificationMode?: 'off' | 'silent' | 'normal'
  completionTitle?: string
  completionBody?: string
  clientRequestId?: string
  sessionId?: string
  messageId?: string
  resumeStreamId?: string
  onStreamAttached?: (id: string) => void
}

const ACTIVE_PULL_INTERVAL_MS = 50
const IDLE_PULL_INTERVAL_MS = 120
const MAX_PULL_CHUNKS = 32
const DEFAULT_PULL_BYTES = 64 * 1024
const MIN_PULL_BYTES = 32 * 1024
const MAX_PULL_RETRY_DELAY_MS = 1000
const MAX_PENDING_CHUNKS = 256
const MAX_PENDING_BYTES = 1024 * 1024

function createPureAndroidReadableStream(
  options: StartStreamOptions,
  background?: BackgroundStreamOptions
): ReadableStream<Uint8Array> {
  let streamId = background?.resumeStreamId || createStreamId()
  let removeAppState: (() => void) | null = null
  let pullTimer: ReturnType<typeof setTimeout> | null = null
  let pullInFlight = false
  let pullRequested = false
  let taskReady = false
  let streamSettled = false
  let appActive = true
  let documentVisible = document.visibilityState !== 'hidden'
  const textEncoder = new TextEncoder()
  const pendingChunks = new Map<number, Uint8Array>()
  let expectedSequence = 0
  let nativeReadThrough = -1
  let pendingBytes = 0
  let terminalSnapshot: { state: 'ended' | 'error' | 'cancelled'; lastSequence: number; error?: string } | null = null
  let pullMaxBytes = DEFAULT_PULL_BYTES
  let consecutivePullFailures = 0
  let consecutiveCursorStalls = 0
  let lastCursorStallLogAt = 0
  let activeController: ReadableStreamDefaultController<Uint8Array> | null = null
  let registeredStreamId: string | null = null

  const unregisterReader = () => {
    if (registeredStreamId) releaseActiveNativeStreamReader(registeredStreamId)
    registeredStreamId = null
  }

  const retainReaderDuringFrontendFinalization = () => {
    if (!registeredStreamId) return
    const id = registeredStreamId
    const registration = activeNativeStreamReaders.get(id)
    if (!registration || registration.wake !== wakeReader) return
    if (registration.releaseTimer) clearTimeout(registration.releaseTimer)
    registration.releaseTimer = setTimeout(() => {
      if (activeNativeStreamReaders.get(id) === registration) {
        activeNativeStreamReaders.delete(id)
      }
    }, READER_FINALIZATION_GRACE_MS)
  }

  const cleanup = () => {
    if (pullTimer) {
      clearTimeout(pullTimer)
      pullTimer = null
    }
    removeAppState?.()
    removeAppState = null
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }

  const settle = (controller: ReadableStreamDefaultController<Uint8Array>, type: 'end' | 'error', error?: string) => {
    if (streamSettled) return
    writeGenerationDebugLog('bridge_reader_completed', {
      streamId,
      state: type,
      afterSequence: nativeReadThrough,
      returnedThrough: expectedSequence - 1,
      pendingChunks: pendingChunks.size,
      pendingBytes,
      errorType: error ? 'native_stream_error' : undefined,
    })
    streamSettled = true
    activeController = null
    cleanup()
    retainReaderDuringFrontendFinalization()
    if (type === 'error') {
      controller.error(new Error(error || 'Native stream error'))
    } else {
      controller.close()
    }
  }

  const finishIfReady = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!terminalSnapshot || expectedSequence <= terminalSnapshot.lastSequence) return false
    const terminal = terminalSnapshot
    // Erroring a ReadableStream drops queued chunks. Surface a real transport
    // error only after every cached byte has been consumed by the provider parser.
    if (terminal.state === 'error' && (controller.desiredSize ?? 0) <= 0) {
      return false
    }
    terminalSnapshot = null
    settle(controller, terminal.state === 'error' ? 'error' : 'end', terminal.error)
    return true
  }

  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    while (pendingChunks.has(expectedSequence) && (controller.desiredSize ?? 1) > 0) {
      const bytes = pendingChunks.get(expectedSequence)
      pendingChunks.delete(expectedSequence)
      expectedSequence += 1
      if (bytes?.byteLength) {
        pendingBytes -= bytes.byteLength
        controller.enqueue(bytes)
      }
    }
    finishIfReady(controller)
  }

  const decodeBase64 = (value: string): Uint8Array => {
    const binary = globalThis.atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }

  const acceptChunk = (sequence: number, chunk: NativeStreamChunk) => {
    const normalizedSequence = Number(sequence)
    if (!Number.isSafeInteger(normalizedSequence) || normalizedSequence < 0) {
      console.warn(`Native stream ${streamId} returned an invalid chunk sequence`, sequence)
      return false
    }
    if (normalizedSequence <= nativeReadThrough) return false
    if (normalizedSequence !== nativeReadThrough + 1) {
      console.warn(`Native stream ${streamId} returned a non-contiguous chunk at ${normalizedSequence}`)
      return false
    }
    const bytes = chunk.chunkBase64 ? decodeBase64(chunk.chunkBase64) : textEncoder.encode(chunk.chunk || '')
    pendingChunks.set(normalizedSequence, bytes)
    pendingBytes += bytes.byteLength
    nativeReadThrough = normalizedSequence
    return true
  }

  const hasPendingCapacity = () => {
    return pendingChunks.size < MAX_PENDING_CHUNKS && pendingBytes < MAX_PENDING_BYTES
  }

  const schedulePull = (delay: number) => {
    if (
      !appActive ||
      !documentVisible ||
      !taskReady ||
      streamSettled ||
      !activeController ||
      pullTimer ||
      !hasPendingCapacity()
    )
      return
    if (pullInFlight) {
      pullRequested = true
      return
    }
    pullTimer = setTimeout(() => {
      pullTimer = null
      void pullSnapshot()
    }, delay)
  }

  const wakeReader = () => {
    documentVisible = document.visibilityState === 'visible'
    if (!documentVisible || !taskReady || streamSettled || !activeController) return

    // A visible document is sufficient to optimistically drain the native buffer. Refresh
    // Capacitor state as well, but do not let a missed appStateChange event strand the cursor.
    appActive = true
    flush(activeController)
    schedulePull(0)
    void App.getState()
      .then(({ isActive }) => {
        // Some Android builds briefly report the previous inactive state while the
        // notification-open transition is already presenting a visible WebView.
        if (isActive) {
          appActive = true
          schedulePull(0)
        }
      })
      .catch(() => {
        appActive = true
        schedulePull(0)
      })
  }

  const registerReader = () => {
    unregisterReader()
    registeredStreamId = streamId
    activeNativeStreamReaders.set(streamId, { wake: wakeReader })
    writeGenerationDebugLog('bridge_reader_started', {
      streamId,
      afterSequence: nativeReadThrough,
      expectedSequence,
    })
  }

  const pullSnapshot = async () => {
    const controller = activeController
    if (!appActive || !documentVisible || !taskReady || streamSettled || !controller) return
    if (pullInFlight) {
      pullRequested = true
      return
    }

    pullInFlight = true
    pullRequested = false
    let receivedChunks = false
    let hasMoreBacklog = false
    let pullFailed = false
    let cursorStalled = false
    try {
      const requestedAfterSequence = nativeReadThrough
      const snapshot = await PureStreamHttp.attachStream({
        id: streamId,
        afterSequence: requestedAfterSequence,
        maxChunks: MAX_PULL_CHUNKS,
        maxBytes: pullMaxBytes,
      })
      if (!appActive || !documentVisible || streamSettled || activeController !== controller) return

      consecutivePullFailures = 0
      pullMaxBytes = DEFAULT_PULL_BYTES
      receivedChunks = snapshot.chunks.length > 0
      hasMoreBacklog = snapshot.hasMore
      if (snapshot.state === 'ended' || snapshot.state === 'error' || snapshot.state === 'cancelled') {
        terminalSnapshot = {
          state: snapshot.state,
          lastSequence: snapshot.lastSequence,
          error: snapshot.error,
        }
      }
      let acceptedChunks = 0
      for (const record of snapshot.chunks) {
        if (acceptChunk(record.sequence, record)) acceptedChunks += 1
      }
      cursorStalled = snapshot.chunks.length > 0 && acceptedChunks === 0
      if (cursorStalled) {
        consecutiveCursorStalls += 1
        const now = Date.now()
        if (consecutiveCursorStalls === 1 || now - lastCursorStallLogAt >= 5000) {
          lastCursorStallLogAt = now
          writeGenerationDebugLog('bridge_cursor_stalled', {
            streamId,
            state: snapshot.state,
            afterSequence: requestedAfterSequence,
            firstSequence: Number(snapshot.chunks[0]?.sequence),
            returnedThrough: Number(snapshot.chunks.at(-1)?.sequence),
            lastSequence: snapshot.lastSequence,
            chunkCount: snapshot.chunks.length,
            repeatCount: consecutiveCursorStalls,
          })
        }
      } else if (acceptedChunks > 0) {
        consecutiveCursorStalls = 0
        writeGenerationDebugLog('bridge_snapshot_received', {
          streamId,
          state: snapshot.state,
          afterSequence: requestedAfterSequence,
          firstSequence: Number(snapshot.chunks[0]?.sequence),
          returnedThrough: nativeReadThrough,
          lastSequence: snapshot.lastSequence,
          chunkCount: acceptedChunks,
          hasMore: snapshot.hasMore,
          pendingChunks: pendingChunks.size,
          pendingBytes,
        })
      }
      flush(controller)

      if (finishIfReady(controller)) return
    } catch (error) {
      if (streamSettled) return
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('Stream not found')) {
        settle(controller, 'error', message)
        return
      }
      pullFailed = true
      consecutivePullFailures += 1
      pullMaxBytes = Math.max(MIN_PULL_BYTES, Math.floor(pullMaxBytes / 2))
      console.warn(`Failed to read native stream ${streamId}:`, error)
    } finally {
      pullInFlight = false
      if (!streamSettled && hasPendingCapacity()) {
        const retryDelay = Math.min(
          MAX_PULL_RETRY_DELAY_MS,
          IDLE_PULL_INTERVAL_MS * 2 ** Math.max(0, consecutivePullFailures - 1)
        )
        schedulePull(
          pullFailed
            ? retryDelay
            : cursorStalled
              ? Math.min(MAX_PULL_RETRY_DELAY_MS, IDLE_PULL_INTERVAL_MS * 2 ** Math.min(3, consecutiveCursorStalls))
              : pullRequested || hasMoreBacklog
                ? 0
                : receivedChunks
                  ? ACTIVE_PULL_INTERVAL_MS
                  : IDLE_PULL_INTERVAL_MS
        )
      }
    }
  }

  const handleVisibilityChange = () => {
    documentVisible = document.visibilityState === 'visible'
    if (!documentVisible) {
      if (pullTimer) {
        clearTimeout(pullTimer)
        pullTimer = null
      }
      return
    }
    wakeReader()
  }

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        activeController = controller
        document.addEventListener('visibilitychange', handleVisibilityChange)
        removeAppState = (
          await App.addListener('appStateChange', ({ isActive }) => {
            appActive = isActive
            if (!isActive) {
              if (pullTimer) {
                clearTimeout(pullTimer)
                pullTimer = null
              }
              return
            }
            documentVisible = document.visibilityState === 'visible'
            wakeReader()
          })
        ).remove
        documentVisible = document.visibilityState === 'visible'
        try {
          appActive = (await App.getState()).isActive
        } catch {
          appActive = true
        }

        if (!background?.resumeStreamId) {
          const result = await PureStreamHttp.startStream({
            ...options,
            id: streamId,
            keepAlive: background?.keepAlive,
            notificationTitle: background?.notificationTitle,
            notificationBody: background?.notificationBody,
            notifyWhenComplete: background?.notifyWhenComplete,
            completionNotificationMode: background?.completionNotificationMode,
            completionTitle: background?.completionTitle,
            completionBody: background?.completionBody,
            clientRequestId: background?.clientRequestId,
            sessionId: background?.sessionId,
            messageId: background?.messageId,
          })
          streamId = result.id
        }
        taskReady = true
        registerReader()
        background?.onStreamAttached?.(streamId)
        wakeReader()
      } catch (error) {
        settle(controller, 'error', error instanceof Error ? error.message : 'Failed to start native stream')
      }
    },
    pull: () => {
      if (activeController) {
        flush(activeController)
      }
      schedulePull(0)
    },
    cancel: async () => {
      writeGenerationDebugLog('bridge_reader_cancelled', {
        streamId,
        afterSequence: nativeReadThrough,
        returnedThrough: expectedSequence - 1,
        pendingChunks: pendingChunks.size,
        pendingBytes,
      })
      try {
        await PureStreamHttp.cancelStream({ id: streamId })
      } finally {
        streamSettled = true
        activeController = null
        cleanup()
        unregisterReader()
      }
    },
  })
}

function createCompatibleEventReadableStream(options: StartStreamOptions): ReadableStream<Uint8Array> {
  let streamId: string | null = null
  let removeChunk: (() => void) | null = null
  let removeEnd: (() => void) | null = null
  let removeError: (() => void) | null = null
  const textEncoder = new TextEncoder()

  const cleanup = () => {
    removeChunk?.()
    removeEnd?.()
    removeError?.()
    removeChunk = null
    removeEnd = null
    removeError = null
  }

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        removeChunk = (
          await CompatibleStreamHttp.addListener('chunk', (data) => {
            if (streamId && data.id === streamId && data.chunk) {
              controller.enqueue(textEncoder.encode(data.chunk))
            }
          })
        ).remove
        removeEnd = (
          await CompatibleStreamHttp.addListener('end', (data) => {
            if (streamId && data.id === streamId) {
              cleanup()
              controller.close()
            }
          })
        ).remove
        removeError = (
          await CompatibleStreamHttp.addListener('error', (data) => {
            if (streamId && data.id === streamId) {
              cleanup()
              controller.error(new Error(data.error || 'Native stream error'))
            }
          })
        ).remove

        streamId = (await CompatibleStreamHttp.startStream(options)).id
      } catch (error) {
        cleanup()
        controller.error(error instanceof Error ? error : new Error('Failed to start native stream'))
      }
    },
    cancel: async () => {
      try {
        if (streamId) {
          await CompatibleStreamHttp.cancelStream({ id: streamId })
        }
      } finally {
        cleanup()
      }
    },
  })
}

export function createNativeReadableStream(
  options: StartStreamOptions,
  background?: BackgroundStreamOptions
): ReadableStream<Uint8Array> {
  return CHATBOX_BUILD_PLATFORM === 'android'
    ? createPureAndroidReadableStream(options, background)
    : createCompatibleEventReadableStream(options)
}
