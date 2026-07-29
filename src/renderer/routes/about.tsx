import { Center, Text } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Page from '@/components/layout/Page'
import platform from '@/platform'

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
  }, [])

  return (
    <Page title={t('About')}>
      <Center h="100%">
        {version && (
          <Text size="lg" c="chatbox-secondary">
            v{displayVersion}
          </Text>
        )}
      </Center>
    </Page>
  )
}
