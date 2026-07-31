import { Button, Center, Stack, Text } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Page from '@/components/layout/Page'
import platform from '@/platform'
import { checkForPureUpdate, installUpdate, syncNativeUpdateState, useUpdateStore } from '@/stores/updateStore'

export const Route = createFileRoute('/about')({
  component: RouteComponent,
})

export function RouteComponent() {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const displayVersion = version.endsWith('.0') ? version.slice(0, -2) : version

  useEffect(() => {
    void platform
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion(''))

    void syncNativeUpdateState().then((nativeUpdateActive) => {
      if (!nativeUpdateActive) void checkForPureUpdate()
    })
  }, [])

  return (
    <Page title={t('About')}>
      <Center h="100%">
        <Stack align="center" gap="sm">
          {version && (
            <Text size="lg" c="chatbox-secondary">
              v{displayVersion}
            </Text>
          )}
          <AboutUpdateControl />
        </Stack>
      </Center>
    </Page>
  )
}

export function AboutUpdateControl() {
  const { t } = useTranslation()
  const status = useUpdateStore((state) => state.status)
  const updateVersion = useUpdateStore((state) => state.version)
  const progress = useUpdateStore((state) => state.progress)
  const hasUpdatePackage = useUpdateStore((state) => !!state.version && !!state.downloadUrl)

  const updateAvailable = status === 'available' || status === 'permission-required' || status === 'downloaded'
  const busy = status === 'checking' || status === 'downloading' || status === 'verifying' || status === 'installing'

  const handleClick = () => {
    if (updateAvailable || (status === 'error' && hasUpdatePackage)) {
      void installUpdate()
      return
    }
    void checkForPureUpdate()
  }

  let statusText: string | null = null
  if (status === 'up-to-date') {
    statusText = t('Already up to date')
  } else if (status === 'error') {
    statusText = t('Update failed')
  } else if (updateAvailable) {
    statusText = `${t('New version available')}${updateVersion ? ` v${updateVersion}` : ''}`
  } else if (status === 'downloading') {
    statusText = `${t('Downloading...')} ${progress}%`
  } else if (status === 'verifying') {
    statusText = t('Verifying update...')
  } else if (status === 'installing') {
    statusText = t('Opening installer...')
  }

  let buttonText = t('Check Update')
  if (status === 'checking') buttonText = t('Checking...')
  else if (status === 'downloading') buttonText = `${t('Downloading...')} ${progress}%`
  else if (status === 'verifying') buttonText = t('Verifying update...')
  else if (status === 'installing') buttonText = t('Opening installer...')
  else if (status === 'permission-required') buttonText = t('Allow installation')
  else if (status === 'downloaded') buttonText = t('Install update')
  else if (status === 'available')
    buttonText = `${t('Download and install')}${updateVersion ? ` v${updateVersion}` : ''}`
  else if (status === 'error') buttonText = t('Retry')

  return (
    <Stack align="center" gap={4}>
      <Button
        size="xs"
        radius="xl"
        variant={updateAvailable ? 'light' : 'default'}
        color={updateAvailable ? 'chatbox-brand' : undefined}
        loading={busy}
        disabled={busy}
        onClick={handleClick}
      >
        {buttonText}
      </Button>
      {statusText && (
        <Text size="xs" c={status === 'error' ? 'chatbox-error' : 'chatbox-tertiary'}>
          {statusText}
        </Text>
      )}
    </Stack>
  )
}
