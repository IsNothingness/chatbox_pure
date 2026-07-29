import { compareVersions } from 'compare-versions'
import { t } from 'i18next'
import { create } from 'zustand'
import platform from '@/platform'
import { settingsStore } from './settingsStore'

const PURE_RELEASE_METADATA_URL =
  'https://raw.githubusercontent.com/IsNothingness/chatbox_pure/main/release-metadata.json'
const UPDATE_INTERVAL = 2 * 60 * 60 * 1000

interface FullUpdatePackage {
  url: string
  sha256?: string
  size?: number
}

interface PureReleaseMetadata {
  schemaVersion: 1
  version: string
  publishedAt: string
  releasePage: string
  packages: Record<string, FullUpdatePackage>
}

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

interface UpdateState {
  status: UpdateStatus
  progress: number
  version: string | null
  downloadUrl: string | null
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
  error: null,
  dismissedVersion: null,

  dismiss() {
    set({ dismissedVersion: get().version })
  },
}))

export function installUpdate() {
  const downloadUrl = useUpdateStore.getState().downloadUrl
  if (!downloadUrl) {
    useUpdateStore.setState({ status: 'error', error: t('Update failed') })
    return
  }
  platform.openLink(downloadUrl).catch(() => {
    useUpdateStore.setState({ status: 'error', error: t('Update failed') })
  })
}

function isPureReleaseMetadata(value: unknown): value is PureReleaseMetadata {
  if (!value || typeof value !== 'object') return false
  const metadata = value as Partial<PureReleaseMetadata>
  return (
    metadata.schemaVersion === 1 &&
    typeof metadata.version === 'string' &&
    typeof metadata.releasePage === 'string' &&
    !!metadata.packages &&
    typeof metadata.packages === 'object'
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
  useUpdateStore.setState({ status: 'checking', error: null })
  try {
    const response = await fetch(PURE_RELEASE_METADATA_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Release metadata request failed: HTTP ${response.status}`)
    const metadata: unknown = await response.json()
    if (!isPureReleaseMetadata(metadata)) throw new Error('Invalid Pure release metadata')

    const currentVersion = await platform.getVersion()
    if (compareVersions(currentVersion, metadata.version) >= 0) {
      useUpdateStore.setState({ status: 'up-to-date', version: null, downloadUrl: null })
      return
    }

    const targetPackage = await getPackage(metadata)
    useUpdateStore.setState((state) => ({
      status: 'available',
      version: metadata.version,
      downloadUrl: targetPackage?.url || metadata.releasePage,
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

/** Starts the repository-owned full-package update checker on every packaged platform. */
export function initUpdateManager() {
  if (initialized) return
  initialized = true

  if (!settingsStore.getState().autoUpdate) return
  void checkForPureUpdate()
  setInterval(() => void checkForPureUpdate(), UPDATE_INTERVAL)
}
