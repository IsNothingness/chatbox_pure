import { Button, Paper, Stack, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { navigateToSettings } from '@/modals/Settings'
import type { HomeWelcomeCardMode } from '@/utils/homeWelcomeCard'

export function ChatboxWelcomeCard(props: { mode: HomeWelcomeCardMode; pageName: string; className?: string }) {
  const { mode, className } = props
  const { t } = useTranslation()

  if (mode === 'none') return null

  return (
    <Paper
      radius="md"
      withBorder
      py="md"
      px="sm"
      className={`bg-white/40 dark:bg-zinc-900/40 backdrop-blur-md ${className || ''}`}
    >
      <Stack gap="sm" align="center">
        <Text fw={600} className="text-center">
          {t('Select and configure an AI model provider')}
        </Text>
        <Button size="xs" h={32} miw={160} fw={600} onClick={() => navigateToSettings('provider')}>
          {t('Setup Provider')}
        </Button>
      </Stack>
    </Paper>
  )
}
