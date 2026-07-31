// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Theme } from '../../shared/types'
import useAppTheme from './useAppTheme'

const mocks = vi.hoisted(() => {
  const state = {
    theme: 2,
    dark: true,
    realTheme: 'light' as 'light' | 'dark',
  }
  return {
    state,
    setUIState: vi.fn((next: { realTheme: 'light' | 'dark' }) => {
      state.realTheme = next.realTheme
    }),
    shouldUseDarkColors: vi.fn(async () => state.dark),
    setStatusBarStyle: vi.fn(async (_options: { darkIcons: boolean }) => {}),
    removeSystemThemeListener: vi.fn(),
    removeWindowFocusedListener: vi.fn(),
    systemThemeCallback: undefined as (() => void) | undefined,
    windowFocusedCallback: undefined as (() => void) | undefined,
  }
})

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({ theme: mocks.state.theme }),
  },
  useLanguage: () => 'en',
  useSettingsStore: (selector: (state: { theme: number }) => unknown) => selector({ theme: mocks.state.theme }),
}))

vi.mock('@/stores/uiStore', () => ({
  uiStore: {
    setState: mocks.setUIState,
  },
  useUIStore: (selector: (state: { realTheme: 'light' | 'dark' }) => unknown) =>
    selector({ realTheme: mocks.state.realTheme }),
}))

vi.mock('../platform', () => ({
  default: {
    shouldUseDarkColors: mocks.shouldUseDarkColors,
    setStatusBarStyle: mocks.setStatusBarStyle,
    onSystemThemeChange: (callback: () => void) => {
      mocks.systemThemeCallback = callback
      return mocks.removeSystemThemeListener
    },
    onWindowFocused: (callback: () => void) => {
      mocks.windowFocusedCallback = callback
      return mocks.removeWindowFocusedListener
    },
  },
}))

vi.mock('../platform/desktop_platform', () => ({
  default: class DesktopPlatform {},
}))

describe('useAppTheme system theme synchronization', () => {
  beforeEach(() => {
    mocks.state.theme = Theme.System
    mocks.state.dark = true
    mocks.state.realTheme = 'light'
    mocks.setUIState.mockClear()
    mocks.shouldUseDarkColors.mockClear()
    mocks.setStatusBarStyle.mockClear()
    mocks.removeSystemThemeListener.mockClear()
    mocks.removeWindowFocusedListener.mockClear()
    mocks.systemThemeCallback = undefined
    mocks.windowFocusedCallback = undefined
    localStorage.clear()
  })

  afterEach(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
  })

  it('refreshes on native theme changes and when the app returns to the foreground', async () => {
    const { unmount } = renderHook(() => useAppTheme())

    await waitFor(() => expect(mocks.setUIState).toHaveBeenLastCalledWith({ realTheme: 'dark' }))

    mocks.state.dark = false
    act(() => mocks.systemThemeCallback?.())
    await waitFor(() => expect(mocks.setUIState).toHaveBeenLastCalledWith({ realTheme: 'light' }))

    mocks.state.dark = true
    act(() => mocks.windowFocusedCallback?.())
    await waitFor(() => expect(mocks.setUIState).toHaveBeenLastCalledWith({ realTheme: 'dark' }))

    unmount()
    expect(mocks.removeSystemThemeListener).toHaveBeenCalledOnce()
    expect(mocks.removeWindowFocusedListener).toHaveBeenCalledOnce()
  })

  it('reapplies explicit app themes when the mobile surface becomes active', async () => {
    mocks.state.theme = Theme.Light
    const { unmount } = renderHook(() => useAppTheme())

    await waitFor(() => expect(mocks.setStatusBarStyle).toHaveBeenCalledWith({ darkIcons: true }))
    mocks.setStatusBarStyle.mockClear()

    act(() => mocks.windowFocusedCallback?.())
    await waitFor(() => expect(mocks.setStatusBarStyle).toHaveBeenCalledWith({ darkIcons: true }))

    unmount()
  })
})
