import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn(async () => undefined),
  appListeners: new Map<string, (event: { isActive?: boolean }) => void>(),
  appAddListener: vi.fn((eventName: string, listener: (event: { isActive?: boolean }) => void) => {
    mocks.appListeners.set(eventName, listener)
    return Promise.resolve({ remove: vi.fn() })
  }),
  cancel: vi.fn(async () => undefined),
  hasReader: vi.fn(() => false),
  list: vi.fn(),
  getSession: vi.fn(),
  findMessageLocation: vi.fn(),
  resume: vi.fn(async () => undefined),
  wakeReaders: vi.fn(),
}))

vi.mock('@/variables', () => ({ CHATBOX_BUILD_PLATFORM: 'android' }))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: mocks.appAddListener,
  },
}))
vi.mock('@/native/stream-http', () => ({
  acknowledgeNativeStreams: mocks.acknowledge,
  cancelNativeStream: mocks.cancel,
  hasActiveNativeStreamReader: mocks.hasReader,
  listNativeStreamTasks: mocks.list,
  wakeNativeStreamReaders: mocks.wakeReaders,
}))
vi.mock('@/stores/chatStore', () => ({ getSession: mocks.getSession }))
vi.mock('@/stores/session/forks', () => ({ findMessageLocation: mocks.findMessageLocation }))
vi.mock('@/stores/session/orchestration', () => ({ resumeNativeBackgroundGeneration: mocks.resume }))

import {
  initNativeBackgroundGenerationMonitor,
  resumeNativeBackgroundGenerations,
} from './background_generation_recovery'

describe('background generation recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.appListeners.clear()
    mocks.hasReader.mockReturnValue(false)
    mocks.getSession.mockResolvedValue({ id: 'session-1', messages: [] })
  })

  test('wakes and leaves an already attached renderer pipeline as the sole stream consumer', async () => {
    const message = { id: 'message-1', generating: true }
    mocks.list.mockResolvedValue([
      {
        id: 'attached-stream',
        sessionId: 'session-1',
        messageId: 'message-1',
        state: 'ended',
        lastSequence: 2,
        createdAt: 10,
      },
    ])
    mocks.findMessageLocation.mockReturnValue({ list: [message], index: 0 })
    mocks.hasReader.mockReturnValue(true)

    await resumeNativeBackgroundGenerations()

    expect(mocks.wakeReaders).toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.acknowledge).not.toHaveBeenCalled()
  })

  test('resumes only the newest native stream for a generating message', async () => {
    const message = { id: 'message-1', generating: true }
    mocks.list.mockResolvedValue([
      {
        id: 'old-stream',
        sessionId: 'session-1',
        messageId: 'message-1',
        state: 'ended',
        lastSequence: 2,
        createdAt: 10,
      },
      {
        id: 'new-stream',
        sessionId: 'session-1',
        messageId: 'message-1',
        state: 'running',
        lastSequence: 4,
        createdAt: 20,
      },
    ])
    mocks.findMessageLocation.mockReturnValue({ list: [message], index: 0 })

    await resumeNativeBackgroundGenerations()
    await vi.waitFor(() => {
      expect(mocks.resume).toHaveBeenCalledWith('session-1', message, 'new-stream')
    })
    expect(mocks.resume).toHaveBeenCalledTimes(1)
    expect(mocks.acknowledge).toHaveBeenCalledWith(['old-stream'])
  })

  test('cleans up orphaned active and terminal streams without regenerating', async () => {
    mocks.list.mockResolvedValue([
      {
        id: 'active-orphan',
        sessionId: 'session-1',
        messageId: 'message-1',
        state: 'running',
        lastSequence: 1,
        createdAt: 10,
      },
      {
        id: 'terminal-orphan',
        sessionId: 'session-2',
        messageId: 'message-2',
        state: 'ended',
        lastSequence: 3,
        createdAt: 20,
      },
    ])
    mocks.getSession.mockResolvedValue(null)
    mocks.findMessageLocation.mockReturnValue(null)

    await resumeNativeBackgroundGenerations()

    expect(mocks.cancel).toHaveBeenCalledWith('active-orphan')
    expect(mocks.acknowledge).toHaveBeenCalledWith(['terminal-orphan'])
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  test('monitors foreground lifecycle events and starts a recovery pass', async () => {
    const documentListeners = new Map<string, () => void>()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn((eventName: string, listener: () => void) => {
        documentListeners.set(eventName, listener)
      }),
    })
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    mocks.list.mockResolvedValue([])

    initNativeBackgroundGenerationMonitor()
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    await resumeNativeBackgroundGenerations()
    vi.clearAllMocks()
    mocks.list.mockResolvedValue([])

    mocks.appListeners.get('appStateChange')?.({ isActive: true })
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    expect(mocks.wakeReaders).toHaveBeenCalled()
    expect(documentListeners.has('visibilitychange')).toBe(true)
  })
})
