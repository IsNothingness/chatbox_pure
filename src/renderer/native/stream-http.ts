import { App } from '@capacitor/app'
import { type PluginListenerHandle, registerPlugin } from '@capacitor/core'
import { type StartStreamOptions, StreamHttp } from 'capacitor-stream-http'
import { CHATBOX_BUILD_PLATFORM } from '@/variables'

export type { StartStreamOptions } from 'capacitor-stream-http'
export { StreamHttp }

export type NativeStreamState = 'pending' | 'running' | 'ended' | 'error'

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
  requestNotificationPermission(): Promise<{ granted: boolean }>
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

  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    while (pendingChunks.has(expectedSequence)) {
      const bytes = pendingChunks.get(expectedSequence)
      pendingChunks.delete(expectedSequence)
      expectedSequence += 1
      if (bytes?.byteLength) {
        controller.enqueue(bytes)
      }
    }
  }

  const decodeBase64 = (value: string): Uint8Array => {
    const binary = globalThis.atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }

  const acceptChunk = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    sequence: number,
    chunk: NativeStreamChunk
  ) => {
    if (sequence < expectedSequence || pendingChunks.has(sequence)) return
    const bytes = chunk.chunkBase64 ? decodeBase64(chunk.chunkBase64) : textEncoder.encode(chunk.chunk || '')
    pendingChunks.set(sequence, bytes)
    flush(controller)
  }

  const schedulePull = (delay: number) => {
    if (!appActive || !documentVisible || !taskReady || streamSettled || !activeController || pullTimer) return
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
    try {
      const snapshot = await PureStreamHttp.attachStream({
        id: streamId,
        afterSequence: expectedSequence - 1,
        maxChunks: 128,
        maxBytes: 256 * 1024,
      })
      if (!appActive || !documentVisible || streamSettled || activeController !== controller) return

      receivedChunks = snapshot.chunks.length > 0
      hasMoreBacklog = snapshot.hasMore
      for (const record of snapshot.chunks) {
        acceptChunk(controller, record.sequence, record)
      }

      const hasAllTerminalChunks = expectedSequence > snapshot.lastSequence
      if (snapshot.state === 'ended' && hasAllTerminalChunks) {
        settle(controller, 'end')
        return
      }
      if (snapshot.state === 'error' && hasAllTerminalChunks) {
        settle(controller, 'error', snapshot.error)
        return
      }
    } catch (error) {
      if (streamSettled) return
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('Stream not found')) {
        settle(controller, 'error', message)
        return
      }
      console.warn(`Failed to read native stream ${streamId}:`, error)
    } finally {
      pullInFlight = false
      schedulePull(
        pullRequested || hasMoreBacklog ? 0 : receivedChunks ? ACTIVE_PULL_INTERVAL_MS : IDLE_PULL_INTERVAL_MS
      )
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
            schedulePull(0)
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
      schedulePull(0)
    },
    cancel: async () => {
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
