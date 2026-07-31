import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import platform from '@/platform'
import { checkForPureUpdate, useUpdateStore } from './updateStore'

function resetStore() {
  useUpdateStore.setState({
    status: 'idle',
    progress: 0,
    version: null,
    downloadUrl: null,
    sha256: null,
    size: null,
    error: null,
    dismissedVersion: null,
  })
}

describe('updateStore', () => {
  beforeEach(() => {
    resetStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('Pure release metadata', () => {
    it('selects the full package for the current platform when a newer version exists', async () => {
      vi.spyOn(platform, 'getVersion').mockResolvedValue('1.0.0')
      vi.spyOn(platform, 'getPlatform').mockResolvedValue('android')
      vi.spyOn(platform, 'getArch').mockResolvedValue('arm64')
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            schemaVersion: 1,
            version: '2.0.0',
            publishedAt: '2026-07-29T00:00:00Z',
            releasePage: 'https://example.com/releases/latest',
            packages: {
              android: {
                url: 'https://example.com/pure.apk',
                sha256: 'a'.repeat(64),
                size: 123456,
              },
            },
          }),
        })
      )

      await checkForPureUpdate()

      expect(useUpdateStore.getState()).toMatchObject({
        status: 'available',
        version: '2.0.0',
        downloadUrl: 'https://example.com/pure.apk',
        sha256: 'a'.repeat(64),
        size: 123456,
      })
    })

    it('rejects an Android release that has no package hash', async () => {
      vi.spyOn(platform, 'getVersion').mockResolvedValue('1.0.0')
      vi.spyOn(platform, 'getPlatform').mockResolvedValue('android')
      vi.spyOn(platform, 'getArch').mockResolvedValue('arm64')
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            schemaVersion: 1,
            version: '2.0.0',
            publishedAt: '2026-07-29T00:00:00Z',
            releasePage: 'https://example.com/releases/latest',
            packages: {
              android: { url: 'https://example.com/pure.apk', size: 123456 },
            },
          }),
        })
      )

      await checkForPureUpdate()

      expect(useUpdateStore.getState()).toMatchObject({
        status: 'error',
        version: null,
      })
    })

    it('does not offer an older or equal release', async () => {
      vi.spyOn(platform, 'getVersion').mockResolvedValue('2.0.0')
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            schemaVersion: 1,
            version: '2.0.0',
            publishedAt: '2026-07-29T00:00:00Z',
            releasePage: 'https://example.com/releases/latest',
            packages: {
              android: {
                url: 'https://example.com/pure.apk',
                sha256: 'a'.repeat(64),
                size: 123456,
              },
            },
          }),
        })
      )

      await checkForPureUpdate()

      expect(useUpdateStore.getState()).toMatchObject({
        status: 'up-to-date',
        version: null,
        downloadUrl: null,
      })
    })
  })

  describe('initial state', () => {
    it('starts with idle status', () => {
      const state = useUpdateStore.getState()
      expect(state.status).toBe('idle')
      expect(state.progress).toBe(0)
      expect(state.version).toBeNull()
      expect(state.error).toBeNull()
      expect(state.dismissedVersion).toBeNull()
    })
  })

  describe('state transitions', () => {
    it('checking sets status and clears error', () => {
      useUpdateStore.setState({ error: 'previous error' })
      useUpdateStore.setState({ status: 'checking', error: null })
      const state = useUpdateStore.getState()
      expect(state.status).toBe('checking')
      expect(state.error).toBeNull()
    })

    it('available sets version and clears dismissedVersion for new version', () => {
      useUpdateStore.setState({ dismissedVersion: '1.0.0' })
      useUpdateStore.setState({
        status: 'available',
        version: '2.0.0',
        dismissedVersion: null,
      })
      const state = useUpdateStore.getState()
      expect(state.status).toBe('available')
      expect(state.version).toBe('2.0.0')
      expect(state.dismissedVersion).toBeNull()
    })

    it('available preserves dismissedVersion when same version', () => {
      useUpdateStore.setState({ dismissedVersion: '2.0.0' })
      const { dismissedVersion } = useUpdateStore.getState()
      useUpdateStore.setState({
        status: 'available',
        version: '2.0.0',
        dismissedVersion: dismissedVersion === '2.0.0' ? dismissedVersion : null,
      })
      const state = useUpdateStore.getState()
      expect(state.dismissedVersion).toBe('2.0.0')
    })

    it('downloading updates progress', () => {
      useUpdateStore.setState({ status: 'downloading', progress: 50 })
      const state = useUpdateStore.getState()
      expect(state.status).toBe('downloading')
      expect(state.progress).toBe(50)
    })

    it('downloaded sets progress to 100 and version', () => {
      useUpdateStore.setState({
        status: 'downloaded',
        version: '2.0.0',
        progress: 100,
      })
      const state = useUpdateStore.getState()
      expect(state.status).toBe('downloaded')
      expect(state.progress).toBe(100)
      expect(state.version).toBe('2.0.0')
    })

    it('error sets error message and resets progress', () => {
      useUpdateStore.setState({ status: 'downloading', progress: 30 })
      useUpdateStore.setState({ status: 'error', error: 'Network error', progress: 0 })
      const state = useUpdateStore.getState()
      expect(state.status).toBe('error')
      expect(state.error).toBe('Network error')
      expect(state.progress).toBe(0)
    })

    it('up-to-date transitions from checking', () => {
      useUpdateStore.setState({ status: 'checking' })
      useUpdateStore.setState({ status: 'up-to-date' })
      expect(useUpdateStore.getState().status).toBe('up-to-date')
    })
  })

  describe('dismiss', () => {
    it('sets dismissedVersion to current version', () => {
      useUpdateStore.setState({ version: '2.0.0' })
      useUpdateStore.getState().dismiss()
      expect(useUpdateStore.getState().dismissedVersion).toBe('2.0.0')
    })

    it('sets dismissedVersion to null when no version', () => {
      useUpdateStore.getState().dismiss()
      expect(useUpdateStore.getState().dismissedVersion).toBeNull()
    })
  })

  describe('up-to-date auto-reset to idle', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('resets to idle after 3 seconds when status is still up-to-date', () => {
      useUpdateStore.setState({ status: 'up-to-date' })

      // Simulate the timeout logic from initUpdateListeners
      setTimeout(() => {
        if (useUpdateStore.getState().status === 'up-to-date') {
          useUpdateStore.setState({ status: 'idle' })
        }
      }, 3_000)

      expect(useUpdateStore.getState().status).toBe('up-to-date')
      vi.advanceTimersByTime(3_000)
      expect(useUpdateStore.getState().status).toBe('idle')
    })

    it('does not reset if status changed before timeout', () => {
      useUpdateStore.setState({ status: 'up-to-date' })

      setTimeout(() => {
        if (useUpdateStore.getState().status === 'up-to-date') {
          useUpdateStore.setState({ status: 'idle' })
        }
      }, 3_000)

      // User triggers a new check before timeout
      useUpdateStore.setState({ status: 'checking' })
      vi.advanceTimersByTime(3_000)
      expect(useUpdateStore.getState().status).toBe('checking')
    })
  })

  describe('progress dedup', () => {
    it('skips update when progress unchanged and already downloading', () => {
      useUpdateStore.setState({ status: 'downloading', progress: 42 })
      const { progress, status } = useUpdateStore.getState()

      // Simulate the dedup check from initUpdateListeners
      const shouldSkip = status === 'downloading' && progress === 42
      expect(shouldSkip).toBe(true)
    })

    it('does not skip when progress changes', () => {
      useUpdateStore.setState({ status: 'downloading', progress: 42 })
      const { progress, status } = useUpdateStore.getState()

      const shouldSkip = status === 'downloading' && progress === 50
      expect(shouldSkip).toBe(false)
    })
  })
})
