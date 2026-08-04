import { describe, expect, test } from 'vitest'
import {
  consumeNativeGenerationContext,
  recordAttachedNativeStream,
  registerNativeGenerationContext,
  releaseNativeGenerationContext,
} from './background-generation-context'

describe('native background generation context', () => {
  test('offers a recovered stream only to the first streaming request', () => {
    const controller = new AbortController()
    registerNativeGenerationContext(controller.signal, {
      clientRequestId: 'session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      resumeStreamId: 'stream-1',
    })

    expect(consumeNativeGenerationContext(controller.signal)).toEqual({
      clientRequestId: 'session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      resumeStreamId: 'stream-1',
    })
    expect(consumeNativeGenerationContext(controller.signal)).toEqual({
      clientRequestId: 'session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      resumeStreamId: undefined,
    })
  })

  test('tracks each native stream for acknowledgement and clears released state', () => {
    const controller = new AbortController()
    registerNativeGenerationContext(controller.signal, {
      clientRequestId: 'session-2:message-2',
      sessionId: 'session-2',
      messageId: 'message-2',
    })

    recordAttachedNativeStream(controller.signal, 'stream-a')
    recordAttachedNativeStream(controller.signal, 'stream-a')
    recordAttachedNativeStream(controller.signal, 'stream-b')

    expect(releaseNativeGenerationContext(controller.signal)).toEqual(['stream-a', 'stream-b'])
    expect(consumeNativeGenerationContext(controller.signal)).toBeUndefined()
  })
})
