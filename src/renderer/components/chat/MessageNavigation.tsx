import { Box, Button, Divider, Stack } from '@mantine/core'
import { IconArrowDown, IconChevronDown, IconChevronsDown, IconChevronsUp, IconChevronUp } from '@tabler/icons-react'
import { clsx } from 'clsx'
import { type CSSProperties, type FC, memo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

export type MessageNavigationProps = {
  visible: boolean
  onVisibleChange?: (visible: boolean) => void
  onScrollToTop?: () => void
  onScrollToBottom?: () => void
  onScrollToPrev?: () => void
  onScrollToNext?: () => void
}

export const MessageNavigation: FC<MessageNavigationProps> = ({
  visible,
  onVisibleChange,
  onScrollToTop,
  onScrollToBottom,
  onScrollToPrev,
  onScrollToNext,
}) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMouseEnter = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    onVisibleChange?.(true)
  }, [onVisibleChange])

  const handleMouseLeave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      onVisibleChange?.(false)
    }, 2000)
  }, [onVisibleChange])

  return (
    <div
      className={clsx(
        'absolute right-0 py-6 pl-2 bottom-0 transition-all',
        visible ? '-translate-x-3 opacity-100' : 'translate-x-1/2 opacity-0'
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Stack
        gap={6}
        p={'xxs'}
        className="rounded border border-solid border-chatbox-border-primary bg-chatbox-background-primary [&>.mantine-Divider-root]:border-chatbox-border-primary"
      >
        <MessageNavigationButton icon={<IconChevronsUp />} onClick={onScrollToTop} />
        <Divider />
        <MessageNavigationButton icon={<IconChevronUp />} onClick={onScrollToPrev} />
        <Divider />
        <MessageNavigationButton icon={<IconChevronDown />} onClick={onScrollToNext} />
        <Divider />
        <MessageNavigationButton icon={<IconChevronsDown />} onClick={onScrollToBottom} />
      </Stack>
    </div>
  )
}

export default memo(MessageNavigation)

const MessageNavigationButton = ({ icon, ...others }: { icon: React.ReactElement; onClick?: () => void }) => {
  const iconSize = 16
  return (
    <button
      className={clsx(
        'flex border-0 outline-none [-webkit-tap-highlight-color:transparent] p-0 cursor-pointer text-chatbox-tint-tertiary active:translate-y-px',
        'bg-transparent hover:text-chatbox-tint-secondary'
      )}
      {...others}
    >
      <Box component="span" w={iconSize} h={iconSize} className="[&>svg]:w-full [&>svg]:h-full">
        {icon}
      </Box>
    </button>
  )
}

const floatingNavigationButtonStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--chatbox-background-primary) 68%, transparent)',
  WebkitBackdropFilter: 'blur(14px) saturate(1.1)',
  backdropFilter: 'blur(14px) saturate(1.1)',
}

function FloatingNavigationButton(props: {
  label: string
  icon: React.ReactElement
  onClick?: () => void
  style?: CSSProperties
}) {
  return (
    <Button
      aria-label={props.label}
      title={props.label}
      w={40}
      h={40}
      radius={20}
      p={0}
      c="chatbox-primary"
      className="border border-solid border-chatbox-border-primary shadow-lg transition-colors hover:bg-chatbox-background-secondary"
      onClick={props.onClick}
      style={{ ...floatingNavigationButtonStyle, ...props.style }}
    >
      {props.icon}
    </Button>
  )
}

export type MobileMessageNavigationProps = {
  showScrollToTop: boolean
  showScrollToPrev: boolean
  showScrollToBottom: boolean
  onScrollToTop?: () => void
  onScrollToPrev?: () => void
  onScrollToBottom?: () => void
}

export function MobileMessageNavigation(props: MobileMessageNavigationProps) {
  const { t } = useTranslation()
  const items = [
    {
      id: 'top',
      visible: props.showScrollToTop,
      label: t('Return to the top'),
      icon: <IconChevronsUp size={20} />,
      onClick: props.onScrollToTop,
    },
    {
      id: 'previous',
      visible: props.showScrollToPrev,
      label: t('Back to previous message'),
      icon: <IconChevronUp size={20} />,
      onClick: props.onScrollToPrev,
    },
    {
      id: 'bottom',
      visible: props.showScrollToBottom,
      label: t('Scroll to bottom'),
      icon: <IconArrowDown size={20} />,
      onClick: props.onScrollToBottom,
    },
  ]

  return (
    <Stack className="mobile-message-navigation absolute bottom-5 right-3 z-10" gap={8}>
      {items.map((item) => (
        <Box
          key={item.id}
          className={clsx(
            'transition-[opacity,transform] duration-200 ease-out',
            item.visible
              ? 'pointer-events-auto translate-x-0 scale-100 opacity-100'
              : 'pointer-events-none translate-x-3 scale-90 opacity-0'
          )}
        >
          <FloatingNavigationButton label={item.label} icon={item.icon} onClick={item.onClick} />
        </Box>
      ))}
    </Stack>
  )
}

export const ScrollToBottomButton = ({ onClick, style }: { onClick?(): void; style?: CSSProperties }) => {
  const { t } = useTranslation()

  return (
    <Box className="mobile-scroll-to-bottom-button absolute bottom-5 right-2">
      <FloatingNavigationButton
        label={t('Scroll to bottom')}
        icon={<IconArrowDown size={20} />}
        onClick={onClick}
        style={style}
      />
    </Box>
  )
}
