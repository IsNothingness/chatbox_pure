import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../chatStore', () => ({
  getSession: vi.fn(),
  removeMessage: vi.fn().mockResolvedValue(undefined),
  updateMessageCacheSync: vi.fn(),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  updateMessagePreservingCache: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../settingsStore', () => ({
  settingsStore: { getState: vi.fn().mockReturnValue({ getSettings: vi.fn().mockReturnValue({}) }) },
}))

vi.mock('../../uiStore', () => ({
  uiStore: { getState: vi.fn().mockReturnValue({ sessionWebBrowsingMap: {} }) },
}))

vi.mock('@/platform', () => ({ default: { type: 'test' } }))

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }))

vi.mock('@/adapters', () => ({ createModel: vi.fn() }))

vi.mock('@/packages/model-setting-utils', () => ({ getModelDisplayName: vi.fn() }))

vi.mock('@/packages/context-management', () => ({ runCompactionWithUIState: vi.fn() }))

vi.mock('../../settingActions', () => ({
  isPro: vi.fn().mockReturnValue(false),
  getRemoteConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@shared/utils/message', () => ({
  countMessageWords: vi.fn().mockReturnValue(42),
}))

vi.mock('@/packages/token', () => ({
  estimateTokensFromMessages: vi.fn().mockReturnValue(100),
}))

import type { Message } from '@shared/types'
import * as chatStore from '../../chatStore'
import { persistStreamingMessage, removeMessage, updateStreamingCache } from '../messages'

function createTestMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'test-msg-1',
    role: 'assistant',
    contentParts: [{ type: 'text', text: 'hello' }],
    timestamp: 0,
    ...overrides,
  } as Message
}

describe('updateStreamingCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates the cache synchronously with the latest VM snapshot', () => {
    const msg = createTestMessage()
    updateStreamingCache('session-1', msg)
    expect(chatStore.updateMessageCacheSync).toHaveBeenCalledWith(
      'session-1',
      'test-msg-1',
      expect.objectContaining({ id: 'test-msg-1' })
    )
  })

  it('sets message.timestamp', () => {
    const msg = createTestMessage({ timestamp: 0 })
    const before = Date.now()
    updateStreamingCache('session-1', msg)
    expect(msg.timestamp).toBeGreaterThanOrEqual(before)
  })
})

describe('persistStreamingMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls chatStore.updateMessage', async () => {
    const msg = createTestMessage()
    await persistStreamingMessage('session-1', msg)
    expect(chatStore.updateMessage).toHaveBeenCalledWith(
      'session-1',
      'test-msg-1',
      expect.objectContaining({ id: 'test-msg-1' })
    )
  })

  it('sets message.timestamp', async () => {
    const msg = createTestMessage({ timestamp: 0 })
    const before = Date.now()
    await persistStreamingMessage('session-1', msg)
    expect(msg.timestamp).toBeGreaterThanOrEqual(before)
  })

  it('refreshes counting when option is set', async () => {
    const msg = createTestMessage()
    await persistStreamingMessage('session-1', msg, { refreshCounting: true })
    expect(msg.wordCount).toBe(42)
    expect(msg.tokenCount).toBe(100)
    expect(msg.tokenCountMap).toBeUndefined()
  })

  it('does not refresh counting by default', async () => {
    const msg = createTestMessage({ wordCount: 10 })
    await persistStreamingMessage('session-1', msg)
    expect(msg.wordCount).toBe(10)
  })

  it('persists intermediate snapshots without replacing the newer cache', async () => {
    const msg = createTestMessage({ generating: true })
    await persistStreamingMessage('session-1', msg, { preserveCache: true })
    expect(chatStore.updateMessagePreservingCache).toHaveBeenCalledWith('session-1', 'test-msg-1', msg)
    expect(chatStore.updateMessage).not.toHaveBeenCalled()
  })
})

describe('removeMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requests cancellation before deleting a generating message', async () => {
    const cancel = vi.fn()
    vi.mocked(chatStore.getSession).mockResolvedValue({
      id: 'session-1',
      name: 'Session',
      messages: [createTestMessage({ generating: true, cancel })],
    } as never)

    await removeMessage('session-1', 'test-msg-1')

    expect(cancel).toHaveBeenCalledOnce()
    expect(chatStore.removeMessage).toHaveBeenCalledWith('session-1', 'test-msg-1')
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(chatStore.removeMessage).mock.invocationCallOrder[0]
    )
  })
})
