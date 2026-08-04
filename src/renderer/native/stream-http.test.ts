import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appActive: true,
  appStateListener: undefined as ((event: { isActive: boolean }) => void) | undefined,
  acknowledgeStream: vi.fn(() => Promise.resolve()),
  attachStream: vi.fn(),
  cancelStream: vi.fn(() => Promise.resolve()),
  startStream: vi.fn((options: { id: string }) => Promise.resolve({ id: options.id })),
}))

vi.mock('@/variables', () => ({ CHATBOX_BUILD_PLATFORM: 'android' }))
vi.mock('@capacitor/app', () => ({
  App: {
    getState: vi.fn(() => Promise.resolve({ isActive: mocks.appActive })),
    addListener: vi.fn((_eventName: string, listener: (event: { isActive: boolean }) => void) => {
      mocks.appStateListener = listener
      return Promise.resolve({ remove: vi.fn() })
    }),
  },
}))
vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({
    startStream: mocks.startStream,
    attachStream: mocks.attachStream,
    acknowledgeStream: mocks.acknowledgeStream,
    cancelStream: mocks.cancelStream,
  })),
}))
vi.mock('capacitor-stream-http', () => ({ StreamHttp: {} }))

import {
  acknowledgeNativeStreams,
  createNativeReadableStream,
  hasActiveNativeStreamReader,
  wakeNativeStreamReaders,
} from './stream-http'

describe('native pull-backed stream', () => {
  let visibilityListener: (() => void) | undefined
  let visibilityState: DocumentVisibilityState

  const setRendererActive = (active: boolean) => {
    mocks.appActive = active
    visibilityState = active ? 'visible' : 'hidden'
    mocks.appStateListener?.({ isActive: active })
    visibilityListener?.()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.appStateListener = undefined
    mocks.appActive = true
    visibilityListener = undefined
    visibilityState = 'hidden'
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((eventName: string, listener: () => void) => {
        if (eventName === 'visibilitychange') visibilityListener = listener
      }),
      removeEventListener: vi.fn(),
    })
  })

  test('does not read the native task while the renderer is in the background', async () => {
    mocks.attachStream.mockResolvedValue({
      id: 'stream-1',
      state: 'running',
      lastSequence: -1,
      createdAt: 1,
      chunks: [],
    })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      { keepAlive: true, notificationTitle: 'Generating', notificationBody: 'Please wait' }
    )
    const reader = stream.getReader()

    await vi.waitFor(() => expect(mocks.startStream).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(mocks.attachStream).not.toHaveBeenCalled()
    await reader.cancel()
    expect(mocks.cancelStream).toHaveBeenCalledOnce()
  })

  test('never polls before a delayed native task has actually been created', async () => {
    let resolveStart: ((value: { id: string }) => void) | undefined
    mocks.startStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )
    mocks.attachStream.mockResolvedValue({
      id: 'stream-1',
      state: 'ended',
      lastSequence: -1,
      createdAt: 1,
      chunks: [],
      hasMore: false,
    })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      { keepAlive: true, notificationTitle: 'Generating', notificationBody: 'Please wait' }
    )
    const reader = stream.getReader()
    await vi.waitFor(() => expect(mocks.startStream).toHaveBeenCalledOnce())
    const streamId = mocks.startStream.mock.calls[0][0].id

    setRendererActive(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(mocks.attachStream).not.toHaveBeenCalled()

    resolveStart?.({ id: streamId })
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    expect(mocks.attachStream).toHaveBeenCalledOnce()
  })

  test('reads buffered chunks by cursor and completes after returning to the foreground', async () => {
    mocks.attachStream.mockImplementation(({ id, afterSequence }: { id: string; afterSequence: number }) => {
      if (afterSequence < 0) {
        return Promise.resolve({
          id,
          state: 'running',
          lastSequence: 0,
          createdAt: 1,
          chunks: [{ sequence: 0, chunk: 'first' }],
        })
      }
      return Promise.resolve({
        id,
        state: 'ended',
        lastSequence: 1,
        createdAt: 1,
        chunks: [{ sequence: 1, chunk: 'second' }],
      })
    })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      { keepAlive: true, notificationTitle: 'Generating', notificationBody: 'Please wait' }
    )
    const reader = stream.getReader()
    await vi.waitFor(() => expect(mocks.startStream).toHaveBeenCalledOnce())

    setRendererActive(true)

    const decoder = new TextDecoder()
    const first = await reader.read()
    const second = await reader.read()
    const terminal = await reader.read()
    const streamId = mocks.startStream.mock.calls[0][0].id

    expect(decoder.decode(first.value)).toBe('first')
    expect(decoder.decode(second.value)).toBe('second')
    expect(terminal).toEqual({ value: undefined, done: true })
    expect(mocks.attachStream.mock.calls).toEqual([
      [{ id: streamId, afterSequence: -1, maxChunks: 32, maxBytes: 64 * 1024 }],
      [{ id: streamId, afterSequence: 0, maxChunks: 32, maxBytes: 64 * 1024 }],
    ])
  })

  test('replays base64 native chunks without changing binary protocol bytes', async () => {
    mocks.attachStream.mockResolvedValue({
      id: 'stream-1',
      state: 'ended',
      lastSequence: 0,
      createdAt: 1,
      chunks: [{ sequence: 0, chunkBase64: '/wAKgA==' }],
      hasMore: false,
    })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/converse-stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()

    setRendererActive(true)
    const result = await reader.read()
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })

    expect(result.done).toBe(false)
    expect([...(result.value ?? new Uint8Array())]).toEqual([255, 0, 10, 128])
  })

  test('delivers the durable tail before surfacing a terminal transport error', async () => {
    mocks.attachStream.mockResolvedValue({
      id: 'stream-1',
      state: 'error',
      error: 'network failed',
      lastSequence: 0,
      createdAt: 1,
      chunks: [{ sequence: 0, chunk: 'durable-tail' }],
      hasMore: false,
    })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()
    setRendererActive(true)

    const tail = await reader.read()
    expect(new TextDecoder().decode(tail.value)).toBe('durable-tail')
    await expect(reader.read()).rejects.toThrow('network failed')
  })

  test('closes a gracefully cancelled stream after delivering its durable tail', async () => {
    mocks.attachStream.mockResolvedValue({
      id: 'stream-1',
      state: 'error',
      error: 'Cancelled',
      lastSequence: 0,
      createdAt: 1,
      chunks: [{ sequence: 0, chunk: 'last-complete-event' }],
      hasMore: false,
    })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()
    setRendererActive(true)

    const tail = await reader.read()
    expect(new TextDecoder().decode(tail.value)).toBe('last-complete-event')
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
  })

  test('stops polling in the background and immediately resumes from the last cursor', async () => {
    mocks.attachStream
      .mockResolvedValueOnce({
        id: 'stream-1',
        state: 'running',
        lastSequence: 0,
        createdAt: 1,
        chunks: [{ sequence: 0, chunk: 'first' }],
      })
      .mockResolvedValue({
        id: 'stream-1',
        state: 'ended',
        lastSequence: 1,
        createdAt: 1,
        chunks: [{ sequence: 1, chunk: 'second' }],
      })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()

    setRendererActive(true)
    await reader.read()
    setRendererActive(false)
    await new Promise((resolve) => setTimeout(resolve, 160))
    expect(mocks.attachStream).toHaveBeenCalledTimes(1)

    setRendererActive(true)
    await reader.read()
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    expect(mocks.attachStream).toHaveBeenLastCalledWith({
      id: 'stream-1',
      afterSequence: 0,
      maxChunks: 32,
      maxBytes: 64 * 1024,
    })
  })

  test('drains a completed native buffer when the app monitor wakes a reader after a missed lifecycle event', async () => {
    mocks.attachStream.mockResolvedValue({
      id: 'stream-1',
      state: 'ended',
      lastSequence: 0,
      createdAt: 1,
      chunks: [{ sequence: 0, chunk: 'completed-in-background' }],
      hasMore: false,
    })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.attachStream).not.toHaveBeenCalled()

    // Simulate Android making the WebView visible without delivering the stream-local
    // appStateChange/visibilitychange callback.
    // App.getState may still expose the previous background state during the transition.
    mocks.appActive = false
    visibilityState = 'visible'
    wakeNativeStreamReaders()

    const result = await reader.read()
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    expect(new TextDecoder().decode(result.value)).toBe('completed-in-background')
    expect(hasActiveNativeStreamReader('stream-1')).toBe(true)

    await acknowledgeNativeStreams(['stream-1'])
    expect(hasActiveNativeStreamReader('stream-1')).toBe(false)
  })

  test('ignores an in-flight foreground read after backgrounding and re-reads it on resume', async () => {
    let resolveFirstRead:
      | ((value: {
          id: string
          state: string
          lastSequence: number
          createdAt: number
          chunks: { sequence: number; chunk: string }[]
          hasMore: boolean
        }) => void)
      | undefined
    mocks.attachStream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve
          })
      )
      .mockResolvedValue({
        id: 'stream-1',
        state: 'ended',
        lastSequence: 0,
        createdAt: 1,
        chunks: [{ sequence: 0, chunk: 'only-on-resume' }],
        hasMore: false,
      })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()

    setRendererActive(true)
    await vi.waitFor(() => expect(mocks.attachStream).toHaveBeenCalledOnce())
    setRendererActive(false)
    resolveFirstRead?.({
      id: 'stream-1',
      state: 'running',
      lastSequence: 0,
      createdAt: 1,
      chunks: [{ sequence: 0, chunk: 'late-background-result' }],
      hasMore: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    setRendererActive(true)
    const result = await reader.read()
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })

    expect(new TextDecoder().decode(result.value)).toBe('only-on-resume')
    expect(mocks.attachStream).toHaveBeenCalledTimes(2)
  })

  test('replays a large background backlog in bounded pages without dropping chunks', async () => {
    const totalChunks = 96
    mocks.attachStream.mockImplementation(
      ({
        id,
        afterSequence,
        maxChunks,
        maxBytes,
      }: {
        id: string
        afterSequence: number
        maxChunks: number
        maxBytes: number
      }) => {
        const firstSequence = afterSequence + 1
        const endSequence = Math.min(totalChunks, firstSequence + maxChunks)
        return Promise.resolve({
          id,
          state: 'ended',
          lastSequence: totalChunks - 1,
          createdAt: 1,
          chunks: Array.from({ length: endSequence - firstSequence }, (_, index) => ({
            sequence: firstSequence + index,
            chunk: `${firstSequence + index},`,
          })),
          hasMore: endSequence < totalChunks,
          maxBytes,
        })
      }
    )

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()
    setRendererActive(true)

    const decoder = new TextDecoder()
    let received = ''
    while (true) {
      const result = await reader.read()
      if (result.done) break
      received += decoder.decode(result.value)
    }

    expect(received).toBe(Array.from({ length: totalChunks }, (_, index) => `${index},`).join(''))
    expect(mocks.attachStream).toHaveBeenCalledTimes(3)
    for (const [options] of mocks.attachStream.mock.calls) {
      expect(options).toMatchObject({ maxChunks: 32, maxBytes: 64 * 1024 })
    }
  })

  test('prefetches native backlog independently from downstream reader demand', async () => {
    const totalChunks = 96
    mocks.attachStream.mockImplementation(
      ({ id, afterSequence, maxChunks }: { id: string; afterSequence: number; maxChunks: number }) => {
        const firstSequence = afterSequence + 1
        const endSequence = Math.min(totalChunks, firstSequence + maxChunks)
        return Promise.resolve({
          id,
          state: 'ended',
          lastSequence: totalChunks - 1,
          createdAt: 1,
          chunks: Array.from({ length: endSequence - firstSequence }, (_, index) => ({
            sequence: firstSequence + index,
            chunk: `${firstSequence + index},`,
          })),
          hasMore: endSequence < totalChunks,
        })
      }
    )

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()
    setRendererActive(true)

    // The native cursor must keep advancing even when the model parser has not
    // consumed the first queued ReadableStream chunk yet.
    await vi.waitFor(() => expect(mocks.attachStream).toHaveBeenCalledTimes(3))

    const decoder = new TextDecoder()
    let received = ''
    while (true) {
      const result = await reader.read()
      if (result.done) break
      received += decoder.decode(result.value)
    }
    expect(received).toBe(Array.from({ length: totalChunks }, (_, index) => `${index},`).join(''))
  })

  test('shrinks the bridge page and resumes after a transient snapshot failure', async () => {
    mocks.attachStream.mockRejectedValueOnce(new Error('Capacitor bridge payload failed')).mockResolvedValue({
      id: 'stream-1',
      state: 'ended',
      lastSequence: 0,
      createdAt: 1,
      chunks: [{ sequence: 0, chunk: 'recovered' }],
      hasMore: false,
    })

    const stream = createNativeReadableStream(
      { url: 'https://example.com/stream', method: 'POST', headers: {}, body: '{}' },
      {
        keepAlive: true,
        notificationTitle: 'Generating',
        notificationBody: 'Please wait',
        resumeStreamId: 'stream-1',
      }
    )
    const reader = stream.getReader()
    setRendererActive(true)

    const result = await reader.read()
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    expect(new TextDecoder().decode(result.value)).toBe('recovered')
    expect(mocks.attachStream.mock.calls[0][0]).toMatchObject({ maxBytes: 64 * 1024 })
    expect(mocks.attachStream.mock.calls[1][0]).toMatchObject({ maxBytes: 32 * 1024 })
  })
})
