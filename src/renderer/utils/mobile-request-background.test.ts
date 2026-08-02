import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancelNativeStream: vi.fn(() => Promise.resolve()),
  consumeContext: vi.fn(),
  createNativeStream: vi.fn(
    (
      _options: unknown,
      background: {
        onStreamAttached?: (id: string) => void
      }
    ) => {
      background.onStreamAttached?.('native-stream-1')
      return new ReadableStream<Uint8Array>()
    }
  ),
  recordAttached: vi.fn(),
  requestPermission: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: vi.fn() },
}))
vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))
vi.mock('@/native/background-generation-context', () => ({
  consumeNativeGenerationContext: mocks.consumeContext,
  recordAttachedNativeStream: mocks.recordAttached,
}))
vi.mock('@/native/stream-http', () => ({
  cancelNativeStream: mocks.cancelNativeStream,
  requestGenerationNotificationPermission: mocks.requestPermission,
  createNativeReadableStream: mocks.createNativeStream,
}))
vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      getSettings: () => ({
        keepGeneratingInBackground: true,
        notifyWhenGenerationCompletes: true,
        generationCompletionNotification: 'silent',
      }),
    }),
  },
}))

import { handleMobileRequest } from './mobile-request'

describe('mobile background request cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.consumeContext.mockReturnValue({
      clientRequestId: 'request-1',
      sessionId: 'session-1',
      messageId: 'message-1',
    })
  })

  test('cancels the native backend directly when the model stream reader is locked', async () => {
    const controller = new AbortController()
    await handleMobileRequest(
      'https://example.com/stream',
      'POST',
      new Headers({ 'Content-Type': 'application/json' }),
      JSON.stringify({ stream: true }),
      controller.signal
    )

    controller.abort()
    await vi.waitFor(() => expect(mocks.cancelNativeStream).toHaveBeenCalledWith('native-stream-1'))
    expect(mocks.recordAttached).toHaveBeenCalledWith(controller.signal, 'native-stream-1')
    expect(mocks.createNativeStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        notifyWhenComplete: true,
        completionNotificationMode: 'silent',
      })
    )
  })

  test.each([
    ['Gemini SSE URL', 'https://example.com/v1beta/models/gemini:streamGenerateContent?alt=sse', 'text/event-stream'],
    [
      'Bedrock binary event stream',
      'https://bedrock.example.com/model/test/converse-stream',
      'application/vnd.amazon.eventstream',
    ],
  ])('routes %s through the native stream without a stream body flag', async (_name, url, contentType) => {
    const response = await handleMobileRequest(
      url,
      'POST',
      new Headers({ 'Content-Type': 'application/json' }),
      JSON.stringify({ contents: [] })
    )

    expect(mocks.createNativeStream).toHaveBeenCalledOnce()
    expect(mocks.createNativeStream).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: contentType }),
      }),
      expect.anything()
    )
    expect(response.headers.get('Content-Type')).toBe(contentType)
  })
})
