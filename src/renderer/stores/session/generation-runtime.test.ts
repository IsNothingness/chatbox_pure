import type { Message } from '@shared/types'
import { afterEach, describe, expect, test } from 'vitest'
import {
  commitGenerationRuntime,
  getGenerationRuntimeMessage,
  releaseGenerationRuntime,
  startGenerationRuntime,
  updateGenerationRuntime,
} from './generation-runtime'

function message(text: string): Message {
  return {
    id: 'message-1',
    role: 'assistant',
    contentParts: [{ type: 'text', text }],
    generating: true,
  }
}

describe('generation runtime cache', () => {
  afterEach(() => {
    releaseGenerationRuntime('session-1', 'message-1')
  })

  test('keeps the newest complete in-memory snapshot until explicit release', () => {
    startGenerationRuntime('session-1', message('first'))
    updateGenerationRuntime('session-1', message('first second'))
    updateGenerationRuntime('session-1', message('first second third'))

    expect(getGenerationRuntimeMessage('session-1', 'message-1')?.contentParts).toEqual([
      { type: 'text', text: 'first second third' },
    ])

    releaseGenerationRuntime('session-1', 'message-1')
    expect(getGenerationRuntimeMessage('session-1', 'message-1')).toBeUndefined()
  })

  test('keeps the runtime cache while a slow SQL commit is pending, then releases it', async () => {
    let finishWrite: (() => void) | undefined
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    startGenerationRuntime('session-1', message('complete response'))

    const commit = commitGenerationRuntime('session-1', 'message-1', async () => writePending)
    expect(getGenerationRuntimeMessage('session-1', 'message-1')).toBeDefined()

    finishWrite?.()
    await commit
    expect(getGenerationRuntimeMessage('session-1', 'message-1')).toBeUndefined()
  })

  test('retains the runtime cache when the SQL commit fails', async () => {
    startGenerationRuntime('session-1', message('recoverable response'))

    await expect(
      commitGenerationRuntime('session-1', 'message-1', async () => {
        throw new Error('storage failed')
      })
    ).rejects.toThrow('storage failed')

    expect(getGenerationRuntimeMessage('session-1', 'message-1')?.contentParts).toEqual([
      { type: 'text', text: 'recoverable response' },
    ])
  })
})
