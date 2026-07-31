import { type PluginListenerHandle, registerPlugin } from '@capacitor/core'
import { type StartStreamOptions, StreamHttp } from 'capacitor-stream-http'
import { CHATBOX_BUILD_PLATFORM } from '@/variables'

export type { StartStreamOptions } from 'capacitor-stream-http'
export { StreamHttp }

interface PureStartStreamOptions extends StartStreamOptions {
  keepAlive?: boolean
  notificationTitle?: string
  notificationBody?: string
}

interface PureStreamEvent {
  id: string
  chunk?: string
  error?: string
}

interface PureStreamHttpPlugin {
  startStream(options: PureStartStreamOptions): Promise<{ id: string }>
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

export function createNativeReadableStream(
  options: StartStreamOptions,
  background?: {
    keepAlive: boolean
    notificationTitle: string
    notificationBody: string
  }
): ReadableStream<Uint8Array> {
  let streamId: string | null = null
  let removeChunk: (() => void) | null = null
  let removeEnd: (() => void) | null = null
  let removeError: (() => void) | null = null
  // Create single TextEncoder instance to reuse
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
        const nativeStream = getNativeStreamPlugin()
        // Register listeners first
        removeChunk = (
          await nativeStream.addListener('chunk', (data) => {
            if (!streamId || data.id !== streamId) return
            const text = data.chunk || ''
            controller.enqueue(textEncoder.encode(text))
          })
        ).remove

        removeEnd = (
          await nativeStream.addListener('end', (data) => {
            if (!streamId || data.id !== streamId) return
            cleanup()
            controller.close()
          })
        ).remove

        removeError = (
          await nativeStream.addListener('error', (data) => {
            if (!streamId || data.id !== streamId) return
            cleanup()
            controller.error(new Error(data.error || 'Native stream error'))
          })
        ).remove

        // Start the stream after listeners are registered
        const res = await nativeStream.startStream({
          ...options,
          keepAlive: background?.keepAlive,
          notificationTitle: background?.notificationTitle,
          notificationBody: background?.notificationBody,
        })
        streamId = res.id
      } catch (error) {
        // Clean up listeners if startStream fails
        cleanup()
        // Propagate error to the stream controller
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
