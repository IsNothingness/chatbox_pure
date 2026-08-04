import { describe, expect, test, vi } from 'vitest'
import { registerActiveGenerationStop, stopActiveGeneration } from './active-generation'

describe('active generation stop registry', () => {
  test('stops the active runtime task without relying on a serialized message callback', () => {
    const stop = vi.fn()
    const release = registerActiveGenerationStop('session-1', stop)

    expect(stopActiveGeneration('session-1')).toBe(true)
    expect(stop).toHaveBeenCalledOnce()

    release()
    expect(stopActiveGeneration('session-1')).toBe(false)
  })

  test('does not let stale cleanup remove a newer task for the same session', () => {
    const oldStop = vi.fn()
    const nextStop = vi.fn()
    const releaseOld = registerActiveGenerationStop('session-2', oldStop)
    const releaseNext = registerActiveGenerationStop('session-2', nextStop)

    releaseOld()
    expect(stopActiveGeneration('session-2')).toBe(true)
    expect(oldStop).not.toHaveBeenCalled()
    expect(nextStop).toHaveBeenCalledOnce()

    releaseNext()
  })
})
