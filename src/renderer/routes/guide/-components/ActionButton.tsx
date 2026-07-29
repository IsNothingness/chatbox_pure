import { Box, Button, Flex, Group, Stack, Text } from '@mantine/core'
import { IconCirclePlus, IconInfoCircle, IconSettings } from '@tabler/icons-react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScalableIcon } from '@/components/common/ScalableIcon'
import { navigateToSettings } from '@/modals/Settings'
import platform from '@/platform'
import guideRedirectLoadingGif from '@/static/guide/guide-redirect-loading.gif'

const GUIDE_ACTION_BUTTON_MAX_WIDTH = 320
const AUTO_NEW_CHAT_DELAY_SECONDS = 3
const guideActionButtonWidthStyle = {
  width: '100%',
  maxWidth: GUIDE_ACTION_BUTTON_MAX_WIDTH,
} as const

export function ProviderSettingsButton() {
  const { t } = useTranslation()

  return (
    <Flex mt="md" style={guideActionButtonWidthStyle}>
      <Button
        leftSection={<ScalableIcon icon={IconSettings} size={18} />}
        onClick={() => navigateToSettings('/provider')}
        variant="light"
        fullWidth
        h={42}
      >
        {t('Set up API')}
      </Button>
    </Flex>
  )
}

interface NewChatButtonProps {
  label?: string
}

export function NewChatButton({ label }: NewChatButtonProps = {}) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <Flex mt="md" style={guideActionButtonWidthStyle}>
      <Button variant="light" fullWidth h={42} onClick={() => navigate({ to: '/' })}>
        <ScalableIcon icon={IconCirclePlus} className="mr-2" />
        {label ?? t('New Chat')}
      </Button>
    </Flex>
  )
}

interface AutoNewChatLoadingProps {
  waitForWindowFocusBeforeAutoNavigate?: boolean
}

export function AutoNewChatLoading({ waitForWindowFocusBeforeAutoNavigate }: AutoNewChatLoadingProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [remainingSeconds, setRemainingSeconds] = useState(AUTO_NEW_CHAT_DELAY_SECONDS)

  useEffect(() => {
    let cancelled = false
    let countdownTimer: ReturnType<typeof setInterval> | undefined
    let completeTimer: ReturnType<typeof setTimeout> | undefined

    const clearTimers = () => {
      if (countdownTimer) {
        clearInterval(countdownTimer)
        countdownTimer = undefined
      }
      if (completeTimer) {
        clearTimeout(completeTimer)
        completeTimer = undefined
      }
    }

    const startCountdown = () => {
      if (cancelled || countdownTimer || completeTimer || document.visibilityState !== 'visible') return

      setRemainingSeconds(AUTO_NEW_CHAT_DELAY_SECONDS)
      countdownTimer = setInterval(() => {
        setRemainingSeconds((current) => Math.max(0, current - 1))
      }, 1000)
      completeTimer = setTimeout(() => {
        clearTimers()
        setRemainingSeconds(0)
        void navigate({ to: '/' })
      }, AUTO_NEW_CHAT_DELAY_SECONDS * 1000)
    }

    const cancelWindowFocusListener = waitForWindowFocusBeforeAutoNavigate
      ? platform.onWindowFocused(startCountdown)
      : undefined

    const handleVisibilityChange = () => {
      if (!waitForWindowFocusBeforeAutoNavigate && document.visibilityState === 'visible') {
        startCountdown()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    const runInitialCheck = async () => {
      if (waitForWindowFocusBeforeAutoNavigate) {
        const isFocused = await platform.isWindowFocused().catch(() => false)
        if (!cancelled && isFocused) startCountdown()
        return
      }
      startCountdown()
    }
    void runInitialCheck()

    return () => {
      cancelled = true
      clearTimers()
      cancelWindowFocusListener?.()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [navigate, waitForWindowFocusBeforeAutoNavigate])

  return (
    <Group mt="xs" gap="sm" align="center" wrap="nowrap" style={{ ...guideActionButtonWidthStyle, maxWidth: 520 }}>
      <Box
        component="img"
        src={guideRedirectLoadingGif}
        alt=""
        aria-hidden="true"
        style={{ width: 72, height: 72, objectFit: 'contain', flex: '0 0 auto' }}
      />
      <Stack gap={2} flex={1}>
        <Text fw={700} c="chatbox-brand" style={{ fontSize: 16, lineHeight: 1.25 }}>
          {t('Opening a new chat...')}
        </Text>
        <Text c="chatbox-brand" style={{ fontSize: 14, lineHeight: 1.35 }}>
          {t('Sit back, relax. Chatbox will start a new chat in {{count}}s...', { count: remainingSeconds })}
        </Text>
      </Stack>
    </Group>
  )
}

export function NewChatTip() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <Box
      mt="md"
      p="md"
      style={{
        borderRadius: 'var(--mantine-radius-md)',
        background: 'var(--mantine-color-yellow-light)',
        border: '1px solid var(--mantine-color-yellow-light-color)',
      }}
    >
      <Flex align="center" gap="xs" mb={4}>
        <IconInfoCircle size={18} style={{ color: 'var(--mantine-color-yellow-8)', flexShrink: 0 }} />
        <Text size="sm" fw={600} style={{ color: 'var(--mantine-color-yellow-8)' }}>
          {t('This is the onboarding assistant')}
        </Text>
      </Flex>
      <Flex align="center" gap={6} wrap="wrap">
        <Text size="sm" c="dimmed">
          {t('For general conversations, please click')}
        </Text>
        <Button variant="light" size="compact-sm" onClick={() => navigate({ to: '/' })}>
          <ScalableIcon icon={IconCirclePlus} className="mr-1" />
          {t('New Chat')}
        </Button>
        <Text size="sm" c="dimmed">
          {t('on the side bar to start a new conversation.')}
        </Text>
      </Flex>
    </Box>
  )
}
