// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteComponent } from '@/routes/about'
import { useUpdateStore } from '@/stores/updateStore'

const platformMocks = vi.hoisted(() => ({
  getVersion: vi.fn(async () => '1.2.0'),
  getPlatform: vi.fn(async () => 'android'),
  getArch: vi.fn(async () => 'arm64'),
  openLink: vi.fn(async () => undefined),
  startNativeUpdate: vi.fn(async ({ version }: { version: string }) => ({
    status: 'downloading',
    progress: 0,
    version,
  })),
  resumeNativeUpdate: vi.fn(async () => ({
    status: 'installing',
    progress: 100,
    version: '2.0.0',
  })),
  getNativeUpdateState: vi.fn(async () => ({ status: 'idle', progress: 0 })),
  onNativeUpdateStateChange: vi.fn(() => () => undefined),
}))

vi.mock('@/platform', () => ({
  default: {
    type: 'mobile',
    ...platformMocks,
  },
}))

vi.mock('@/components/layout/Page', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

function resetUpdateStore() {
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

describe('About update control', () => {
  beforeEach(() => {
    resetUpdateStore()
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    )
    platformMocks.getVersion.mockClear()
    platformMocks.getPlatform.mockClear()
    platformMocks.getArch.mockClear()
    platformMocks.openLink.mockClear()
    platformMocks.startNativeUpdate.mockClear()
    platformMocks.resumeNativeUpdate.mockClear()
    platformMocks.getNativeUpdateState.mockClear()
    platformMocks.getNativeUpdateState.mockResolvedValue({ status: 'idle', progress: 0 })
    platformMocks.onNativeUpdateStateChange.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('checks Pure metadata and opens the matching Android package', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          version: '2.0.0',
          publishedAt: '2026-07-30T00:00:00Z',
          releasePage: 'https://example.com/releases/latest',
          packages: {
            android: {
              url: 'https://example.com/ChatBox-Pure-2.0.0.apk',
              sha256: 'a'.repeat(64),
              size: 123456,
            },
          },
        }),
      })
    )

    render(
      <MantineProvider>
        <RouteComponent />
      </MantineProvider>
    )

    expect(await screen.findByText('v1.2')).toBeTruthy()
    expect(await screen.findByText('New version available v2.0.0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download and install v2.0.0' }))

    await waitFor(() =>
      expect(platformMocks.startNativeUpdate).toHaveBeenCalledWith({
        version: '2.0.0',
        url: 'https://example.com/ChatBox-Pure-2.0.0.apk',
        sha256: 'a'.repeat(64),
        size: 123456,
      })
    )
    expect(platformMocks.openLink).not.toHaveBeenCalled()
  })

  it('resumes a persisted native update without fetching metadata again', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    platformMocks.getNativeUpdateState.mockResolvedValueOnce({
      status: 'permission-required',
      progress: 0,
      version: '2.0.0',
    })

    render(
      <MantineProvider>
        <RouteComponent />
      </MantineProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Allow installation' }))

    await waitFor(() => expect(platformMocks.resumeNativeUpdate).toHaveBeenCalledOnce())
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
