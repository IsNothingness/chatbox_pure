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
  chunk: string
}

interface NativeStreamSnapshot extends NativeStreamTask {
  chunks: NativeStreamChunk[]
}

interface PureStartStreamOptions extends StartStreamOptions {
  id?: string
  keepAlive?: boolean
  notificationTitle?: string
  notificationBody?: string
  notifyWhenComplete?: boolean
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
  attachStream(options: { id: string; afterSequence: number }): Promise<NativeStreamSnapshot>
  listStreams(): Promise<{ streams: NativeStreamTask[] }>
  acknowledgeStream(options: { id: string }): Promise<void>
  cancelStream(options: { id: string }): Promise<void>
  requestNotificationPermission(): Promise<{ granted: boolean }>
  showCompletionNotification(options: { title: string; body: string }): Promise<void>
  addListener(
    eventName: 'chunk' | 'end' | 'error',
    listenerFunc: (data: PureStreamEvent) => void
  ): Promise<PluginListenerHandle>
}

const PureStreamHttp = registerPlugin<PureStreamHttpPlugin>('PureStreamHttp')
const CompatibleStreamHttp = StreamHttp as unknown as PureStreamHttpPlugin

function getNativeStreamPlugin(): PureStreamHttpPlugin {
  return CHATBOX_BUILD_PLATFORM === 'android' ? PureStreamHttp : CompatibleStreamHttp
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

export async function showGenerationCompleteNotification(title: string, body: string): Promise<void> {
  if (CHATBOX_BUILD_PLATFORM !== 'android') return
  try {
    await PureStreamHttp.showCompletionNotification({ title, body })
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

export function createNativeReadableStream(
  options: StartStreamOptions,
  background?: {
    keepAlive: boolean
    notificationTitle: string
    notificationBody: string
    notifyWhenComplete?: boolean
    completionTitle?: string
    completionBody?: string
    clientRequestId?: string
    sessionId?: string
    messageId?: string
    resumeStreamId?: string
    onStreamAttached?: (id: string) => void
  }
): ReadableStream<Uint8Array> {
  const isPureAndroidStream = CHATBOX_BUILD_PLATFORM === 'android'
  let streamId: string | null = isPureAndroidStream ? background?.resumeStreamId || createStreamId() : null
  let removeChunk: (() => void) | null = null
  let removeEnd: (() => void) | null = null
  let removeError: (() => void) | null = null
  const textEncoder = new TextEncoder()
  const pendingChunks = new Map<number, string>()
  let expectedSequence = 0
  let terminal: { type: 'end' | 'error'; lastSequence: number; error?: string } | null = null

  const cleanup = () => {
    removeChunk?.()
    removeEnd?.()
    removeError?.()
    removeChunk = null
    removeEnd = null
    removeError = null
  }

  const finishIfReady = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!terminal || expectedSequence <= terminal.lastSequence) return
    const result = terminal
    terminal = null
    cleanup()
    if (result.type === 'error') {
      controller.error(new Error(result.error || 'Native stream error'))
    } else {
      controller.close()
    }
  }

  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    while (pendingChunks.has(expectedSequence)) {
      const text = pendingChunks.get(expectedSequence) || ''
      pendingChunks.delete(expectedSequence)
      expectedSequence += 1
      if (text) {
        controller.enqueue(textEncoder.encode(text))
      }
    }
    finishIfReady(controller)
  }

  const acceptChunk = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    sequence: number | undefined,
    chunk: string
  ) => {
    if (!isPureAndroidStream || sequence === undefined) {
      if (chunk) controller.enqueue(textEncoder.encode(chunk))
      return
    }
    if (sequence < expectedSequence || pendingChunks.has(sequence)) return
    pendingChunks.set(sequence, chunk)
    flush(controller)
  }

  const acceptTerminal = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    type: 'end' | 'error',
    lastSequence: number | undefined,
    error?: string
  ) => {
    if (!isPureAndroidStream || lastSequence === undefined) {
      cleanup()
      if (type === 'error') controller.error(new Error(error || 'Native stream error'))
      else controller.close()
      return
    }
    terminal = { type, lastSequence, error }
    finishIfReady(controller)
  }

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        const nativeStream = getNativeStreamPlugin()
        removeChunk = (
          await nativeStream.addListener('chunk', (data) => {
            if (!streamId || data.id !== streamId) return
            acceptChunk(controller, data.sequence, data.chunk || '')
          })
        ).remove

        removeEnd = (
          await nativeStream.addListener('end', (data) => {
            if (!streamId || data.id !== streamId) return
            acceptTerminal(controller, 'end', data.lastSequence)
          })
        ).remove

        removeError = (
          await nativeStream.addListener('error', (data) => {
            if (!streamId || data.id !== streamId) return
            acceptTerminal(controller, 'error', data.lastSequence, data.error)
          })
        ).remove

        if (isPureAndroidStream && background?.resumeStreamId) {
          const snapshot = await nativeStream.attachStream({
            id: background.resumeStreamId,
            afterSequence: -1,
          })
          streamId = snapshot.id
          background.onStreamAttached?.(snapshot.id)
          for (const record of snapshot.chunks) {
            acceptChunk(controller, record.sequence, record.chunk)
          }
          if (snapshot.state === 'ended') {
            acceptTerminal(controller, 'end', snapshot.lastSequence)
          } else if (snapshot.state === 'error') {
            acceptTerminal(controller, 'error', snapshot.lastSequence, snapshot.error)
          }
          return
        }

        const res = await nativeStream.startStream({
          ...options,
          id: isPureAndroidStream ? streamId || undefined : undefined,
          keepAlive: background?.keepAlive,
          notificationTitle: background?.notificationTitle,
          notificationBody: background?.notificationBody,
          notifyWhenComplete: background?.notifyWhenComplete,
          completionTitle: background?.completionTitle,
          completionBody: background?.completionBody,
          clientRequestId: background?.clientRequestId,
          sessionId: background?.sessionId,
          messageId: background?.messageId,
        })
        streamId = res.id
        background?.onStreamAttached?.(res.id)
      } catch (error) {
        cleanup()
        controller.error(error instanceof Error ? error : new Error('Failed to start native stream'))
      }
    },
    cancel: async () => {
      try {
        if (streamId) {
          await getNativeStreamPlugin().cancelStream({ id: streamId })
        }
      } finally {
        cleanup()
      }
    },
  })
}
