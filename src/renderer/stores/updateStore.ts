import { compareVersions } from 'compare-versions'
import { t } from 'i18next'
import { create } from 'zustand'
import platform from '@/platform'
import type { NativeUpdateState } from '@/platform/interfaces'
import { settingsStore } from './settingsStore'

const PURE_RELEASE_METADATA_URL =
  'https://raw.githubusercontent.com/IsNothingness/chatbox_pure/main/release-metadata.json'
const UPDATE_INTERVAL = 2 * 60 * 60 * 1000

interface FullUpdatePackage {
  url: string
  sha256: string
  size: number
}

interface PureReleaseMetadata {
  schemaVersion: 1
  version: string
  publishedAt: string
  releasePage: string
  packages: Record<string, FullUpdatePackage>
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'permission-required'
  | 'downloading'
  | 'verifying'
  | 'downloaded'
  | 'installing'
  | 'error'

interface UpdateState {
  status: UpdateStatus
  progress: number
  version: string | null
  downloadUrl: string | null
  sha256: string | null
  size: number | null
  error: string | null
  dismissedVersion: string | null
}

interface UpdateActions {
  dismiss(): void
}

export const useUpdateStore = create<UpdateState & UpdateActions>((set, get) => ({
  status: 'idle',
  progress: 0,
  version: null,
  downloadUrl: null,
  sha256: null,
  size: null,
  error: null,
  dismissedVersion: null,

  dismiss() {
    set({ dismissedVersion: get().version })
  },
}))

function applyNativeUpdateState(nativeState: NativeUpdateState) {
  if (nativeState.status === 'idle') return
  useUpdateStore.setState({
    status: nativeState.status,
    progress: Math.max(0, Math.min(100, nativeState.progress || 0)),
    version: nativeState.version || useUpdateStore.getState().version,
    error: nativeState.error || null,
  })
}

export async function installUpdate() {
  const state = useUpdateStore.getState()
  const { downloadUrl, sha256, size, version } = state

  try {
    const os = await platform.getPlatform()
    if (os === 'android' && platform.startNativeUpdate && platform.resumeNativeUpdate) {
      if (state.status === 'permission-required' || state.status === 'downloaded') {
        applyNativeUpdateState(await platform.resumeNativeUpdate())
        return
      }
      if (!version || !downloadUrl || !sha256 || !size) {
        throw new Error('Android update metadata is missing SHA-256 or file size')
      }
      applyNativeUpdateState(
        await platform.startNativeUpdate({
          version,
          url: downloadUrl,
          sha256,
          size,
        })
      )
      return
    }

    if (!downloadUrl) throw new Error('Update package URL is missing')
    await platform.openLink(downloadUrl)
  } catch (error) {
    console.error('Failed to install update:', error)
    useUpdateStore.setState({ status: 'error', error: t('Update failed') })
  }
}

function isPureReleaseMetadata(value: unknown): value is PureReleaseMetadata {
  if (!value || typeof value !== 'object') return false
  const metadata = value as Partial<PureReleaseMetadata>
  const packages = metadata.packages ? Object.values(metadata.packages) : []
  return (
    metadata.schemaVersion === 1 &&
    typeof metadata.version === 'string' &&
    typeof metadata.releasePage === 'string' &&
    packages.length > 0 &&
    packages.every(
      (updatePackage) =>
        !!updatePackage &&
        typeof updatePackage === 'object' &&
        typeof updatePackage.url === 'string' &&
        updatePackage.url.startsWith('https://') &&
        /^[a-f0-9]{64}$/i.test(updatePackage.sha256) &&
        Number.isSafeInteger(updatePackage.size) &&
        updatePackage.size > 0
    )
  )
}

function normalizePlatform(os: string): string {
  if (os === 'win32') return 'windows'
  if (os === 'darwin') return 'macos'
  return os
}

async function getPackage(metadata: PureReleaseMetadata): Promise<FullUpdatePackage | undefined> {
  const [os, arch] = await Promise.all([platform.getPlatform(), platform.getArch()])
  const normalized = normalizePlatform(os)
  return metadata.packages[`${normalized}-${arch}`] ?? metadata.packages[normalized]
}

export async function checkForPureUpdate() {
  if (useUpdateStore.getState().status === 'checking') return
  useUpdateStore.setState({ status: 'checking', error: null })
  try {
    const response = await fetch(PURE_RELEASE_METADATA_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Release metadata request failed: HTTP ${response.status}`)
    const metadata: unknown = await response.json()
    if (!isPureReleaseMetadata(metadata)) throw new Error('Invalid Pure release metadata')

    const currentVersion = await platform.getVersion()
    if (compareVersions(currentVersion, metadata.version) >= 0) {
      useUpdateStore.setState({
        status: 'up-to-date',
        version: null,
        downloadUrl: null,
        sha256: null,
        size: null,
      })
      return
    }

    const targetPackage = await getPackage(metadata)
    const os = normalizePlatform(await platform.getPlatform())
    if (os === 'android' && !targetPackage) {
      throw new Error('Android release package is missing from release metadata')
    }
    useUpdateStore.setState((state) => ({
      status: 'available',
      version: metadata.version,
      downloadUrl: targetPackage?.url || metadata.releasePage,
      sha256: targetPackage?.sha256 ?? null,
      size: targetPackage?.size ?? null,
      progress: 0,
      error: null,
      dismissedVersion: state.dismissedVersion === metadata.version ? state.dismissedVersion : null,
    }))
  } catch (error) {
    console.error('Failed to check Pure release metadata:', error)
    useUpdateStore.setState({
      status: 'error',
      error: error instanceof Error ? error.message : t('Update failed'),
    })
  }
}

let initialized = false
let nativeListenerInitialized = false

export async function syncNativeUpdateState(): Promise<boolean> {
  if (!platform.getNativeUpdateState || !platform.onNativeUpdateStateChange) return false

  if (!nativeListenerInitialized) {
    nativeListenerInitialized = true
    platform.onNativeUpdateStateChange(applyNativeUpdateState)
  }

  try {
    const nativeState = await platform.getNativeUpdateState()
    applyNativeUpdateState(nativeState)
    return nativeState.status !== 'idle'
  } catch (error) {
    console.warn('Failed to restore native Android update state:', error)
    return false
  }
}

/** Starts the repository-owned full-package update checker on every packaged platform. */
export function initUpdateManager() {
  if (initialized) return
  initialized = true

  if (!settingsStore.getState().autoUpdate) return
  void syncNativeUpdateState().then((nativeUpdateActive) => {
    if (!nativeUpdateActive) void checkForPureUpdate()
  })
  setInterval(() => void checkForPureUpdate(), UPDATE_INTERVAL)
}
