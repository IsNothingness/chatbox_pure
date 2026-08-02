import { CapacitorHttp } from '@capacitor/core'
import i18n from '@/i18n'
import { consumeNativeGenerationContext, recordAttachedNativeStream } from '@/native/background-generation-context'
import {
  cancelNativeStream,
  createNativeReadableStream,
  requestGenerationNotificationPermission,
} from '@/native/stream-http'
import { settingsStore } from '@/stores/settingsStore'
import { ApiError } from '../../shared/models/errors'

function isLockedStreamCancelError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    (error.message.includes('Cannot cancel a locked stream') ||
      error.message.includes('ReadableStream is locked') ||
      error.message.includes('stream is locked'))
  )
}

function hasStreamingBody(body: RequestInit['body']): boolean {
  if (typeof body !== 'string') return false
  try {
    const parsed = JSON.parse(body) as { stream?: unknown }
    return parsed.stream === true
  } catch {
    return false
  }
}

function isNativeStreamingRequest(url: string, headers: Headers, body: RequestInit['body']): boolean {
  const normalizedUrl = url.toLowerCase()
  const accept = headers.get('accept')?.toLowerCase() || ''
  return (
    hasStreamingBody(body) ||
    accept.includes('text/event-stream') ||
    accept.includes('application/vnd.amazon.eventstream') ||
    normalizedUrl.includes('streamgeneratecontent') ||
    normalizedUrl.includes('alt=sse') ||
    normalizedUrl.includes('/converse-stream') ||
    normalizedUrl.includes('/invoke-with-response-stream')
  )
}

function getNativeResponseContentType(url: string, headers: Headers): string {
  const normalizedUrl = url.toLowerCase()
  if (
    normalizedUrl.includes('/converse-stream') ||
    normalizedUrl.includes('/invoke-with-response-stream') ||
    headers.get('accept')?.toLowerCase().includes('application/vnd.amazon.eventstream')
  ) {
    return 'application/vnd.amazon.eventstream'
  }
  return 'text/event-stream'
}

export function cancelReadableStreamOnAbort(stream: ReadableStream<Uint8Array>) {
  try {
    void stream.cancel('aborted').catch((error: unknown) => {
      if (!isLockedStreamCancelError(error)) {
        console.warn('Failed to cancel native stream', error)
      }
    })
  } catch (error) {
    if (!isLockedStreamCancelError(error)) {
      console.warn('Failed to cancel native stream', error)
    }
  }
}

export async function handleMobileRequest(
  url: string,
  method: string,
  headers: Headers,
  body?: RequestInit['body'],
  signal?: AbortSignal
): Promise<Response> {
  // Fix: Convert Headers to plain object without using .entries()
  const headerObj: Record<string, string> = {}
  headers.forEach((value, key) => {
    headerObj[key] = value
  })
  const isStreaming = isNativeStreamingRequest(url, headers, body)

  if (isStreaming) {
    try {
      // Add SSE Accept header for proper content negotiation
      const streamHeaders = {
        ...headerObj,
        Accept: getNativeResponseContentType(url, headers),
      }

      const settings = settingsStore.getState().getSettings()
      const completionNotificationMode =
        settings.generationCompletionNotification ?? (settings.notifyWhenGenerationCompletes ? 'silent' : 'off')
      const generationContext = consumeNativeGenerationContext(signal)
      let attachedNativeStreamId: string | undefined
      if (settings.keepGeneratingInBackground && !generationContext?.resumeStreamId) {
        // This request is initiated by an explicit send action, which is the most
        // relevant moment to ask Android 13+ for foreground/completion notifications.
        // A denied permission does not prevent the foreground service from running.
        await requestGenerationNotificationPermission()
      }
      const stream = createNativeReadableStream(
        {
          url,
          method,
          headers: streamHeaders,
          body: body as string,
        },
        {
          keepAlive: settings.keepGeneratingInBackground,
          notificationTitle: i18n.t('ChatBox Pure is generating a reply'),
          notificationBody: i18n.t('You can leave the app or turn off the screen.'),
          notifyWhenComplete: completionNotificationMode !== 'off',
          completionNotificationMode,
          completionTitle: i18n.t('Reply generated') || 'Reply generated',
          completionBody:
            i18n.t('Tap to return to ChatBox Pure and view the reply.') ||
            'Tap to return to ChatBox Pure and view the reply.',
          clientRequestId: generationContext?.clientRequestId,
          sessionId: generationContext?.sessionId,
          messageId: generationContext?.messageId,
          resumeStreamId: generationContext?.resumeStreamId,
          onStreamAttached: (streamId) => {
            attachedNativeStreamId = streamId
            recordAttachedNativeStream(signal, streamId)
            if (signal?.aborted) {
              void cancelNativeStream(streamId)
            }
          },
        }
      )

      // Handle abort signal for stream cancellation
      if (signal) {
        const onAbort = () => {
          if (attachedNativeStreamId) {
            // The model pipeline normally holds a reader lock, which prevents
            // ReadableStream.cancel() from reaching the underlying native source.
            // Cancel the backend task directly as the authoritative path.
            void cancelNativeStream(attachedNativeStreamId)
          }
          cancelReadableStreamOnAbort(stream)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      // TODO: Once native plugin supports returning status/headers,
      // use them instead of hardcoded values
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': getNativeResponseContentType(url, headers),
          'Cache-Control': 'no-cache',
        },
      })
    } catch (err) {
      console.warn('Native streaming unavailable, falling back', err)
    }
  }

  const response = await CapacitorHttp.request({
    url,
    method,
    headers: headerObj,
    data: body,
    responseType: 'text',
  })

  const rawData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
  // Treat status 0 or < 200 as errors, in addition to >= 400
  if (response.status === 0 || response.status < 200 || response.status >= 400) {
    throw new ApiError(`Status Code ${response.status}`, rawData, response.status)
  }
  const responseData = rawData

  if (isStreaming) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseData))
        controller.close()
      },
    })
    return new Response(stream, {
      status: response.status,
      headers: { ...response.headers, 'Content-Type': 'text/event-stream' },
    })
  }

  return new Response(responseData, {
    status: response.status,
    headers: response.headers,
  })
}
