import NiceModal from '@ebay/nice-modal-react'
import { ActionIcon, Flex, Text, Tooltip } from '@mantine/core'
import type { SessionMetaRecord } from '@shared/types'
import {
  IconArchive,
  IconArrowsMoveVertical,
  IconCopy,
  IconDotsVertical,
  IconEdit,
  IconPinned,
  IconPinnedFilled,
  IconTrash,
} from '@tabler/icons-react'
import clsx from 'clsx'
import dayjs from 'dayjs'
import { type MouseEvent, memo, type PointerEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import { navigateToSettings } from '@/modals/Settings'
import { router } from '@/router'
import {
  archiveSession,
  confirmSessionDeletion,
  countArchivedSessionsMeta,
  deleteSession,
  getSession,
  updateSession as updateSessionStore,
} from '@/stores/chatStore'
import { copyAndSwitchSession, switchCurrentSession } from '@/stores/sessionActions'
import { useSettingsStore } from '@/stores/settingsStore'
import * as toastActions from '@/stores/toastActions'
import { useUIStore } from '@/stores/uiStore'
import ActionMenu, { type ActionMenuItemProps } from '../ActionMenu'
import { AssistantAvatar } from '../common/Avatar'
import { ScalableIcon } from '../common/ScalableIcon'

const ARCHIVE_TIP_STORAGE_KEY = 'chatbox:lastArchiveSessionTipAt'
const ARCHIVE_TIP_INTERVAL = 24 * 60 * 60 * 1000
const ARCHIVED_SESSION_CLEANUP_THRESHOLD = 600
function formatSessionTime(createdAt: number) {
  const created = dayjs(createdAt)
  const now = dayjs()
  if (created.isSame(now, 'day')) {
    return created.format('HH:mm')
  }
  if (created.isSame(now, 'year')) {
    return created.format('MM/DD')
  }
  return created.format('YY/MM/DD')
}

export interface Props {
  session: SessionMetaRecord
  selected: boolean
  isReordering?: boolean
  onStartReordering?: () => void
  onSelectWhileReordering?: () => boolean
}

function SessionItem(props: Props) {
  const { session, selected } = props
  const { t } = useTranslation()
  const pinActionLabel = session.starred ? t('Unpin') : t('Pin')
  const archiveActionLabel = t('Archive')
  const conversationListMenu = useSettingsStore((state) => state.conversationListMenu)
  const setShowSidebar = useUIStore((s) => s.setShowSidebar)
  const onClick = () => {
    if (props.isReordering && props.onSelectWhileReordering?.() === false) {
      return
    }
    switchCurrentSession(session.id)
    if (isSmallScreen) {
      setShowSidebar(false)
    }
  }
  const isSmallScreen = useIsSmallScreen()
  // const smallSize = theme.typography.pxToRem(20)

  const [archiving, setArchiving] = useState(false)
  const [copying, setCopying] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionTooltipDismissed, setActionTooltipDismissed] = useState(false)
  const [mobileMenuOpened, setMobileMenuOpened] = useState(false)

  const stopItemClick = (event: MouseEvent | PointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }

  const dismissActionTooltip = () => {
    setActionTooltipDismissed(true)
  }

  const showArchiveTipOncePerDay = () => {
    const now = Date.now()
    const lastTipAt = Number(localStorage.getItem(ARCHIVE_TIP_STORAGE_KEY) || 0)
    if (now - lastTipAt < ARCHIVE_TIP_INTERVAL) {
      return
    }
    localStorage.setItem(ARCHIVE_TIP_STORAGE_KEY, String(now))
    toastActions.add(t('Archived. Manage archived chats in Settings.') || '', 8000, {
      label: t('Manage') || '',
      settingsPath: '/archive',
    })
  }

  const archiveCurrentSession = async () => {
    if (archiving) {
      return
    }
    setArchiving(true)
    try {
      await archiveSession(session.id)
      if (selected) {
        await router.navigate({ to: '/', replace: true })
      }
      const archivedSessionCount = await countArchivedSessionsMeta()
      if (archivedSessionCount > ARCHIVED_SESSION_CLEANUP_THRESHOLD) {
        const confirmed = await NiceModal.show('confirm', {
          title: t('Too many archived chats'),
          message: t('You have archived more than {{count}} chats. Do you want to clean them up now?', {
            count: ARCHIVED_SESSION_CLEANUP_THRESHOLD,
          }),
          confirmText: t('Clean up'),
        })
        if (confirmed === true) {
          navigateToSettings('/archive')
        }
      } else {
        showArchiveTipOncePerDay()
      }
    } catch (error) {
      console.error('Failed to archive session:', error)
      setArchiving(false)
    }
  }

  const deleteCurrentSession = async () => {
    if (deleting || !(await confirmSessionDeletion(session.id))) {
      return
    }
    setDeleting(true)
    try {
      await deleteSession(session.id)
      if (selected) {
        await router.navigate({ to: '/', replace: true })
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
      setDeleting(false)
    }
  }

  const copyCurrentSession = async () => {
    if (copying) {
      return
    }
    setCopying(true)
    try {
      const fullSession = await getSession(session.id)
      if (!fullSession) {
        return
      }
      await copyAndSwitchSession(fullSession)
      setShowSidebar(false)
    } catch (error) {
      console.error('Failed to copy session:', error)
    } finally {
      setCopying(false)
    }
  }

  const editCurrentSession = async () => {
    const fullSession = await getSession(session.id)
    if (!fullSession) {
      return
    }
    await NiceModal.show('session-settings', { session: fullSession })
  }

  const handlePointerLeave = () => {
    setActionTooltipDismissed(false)
  }

  const handleContextMenu = (event: MouseEvent) => {
    if (!isSmallScreen) {
      return
    }
    event.preventDefault()
  }

  const handleMobileMenuChange = (opened: boolean) => {
    setMobileMenuOpened(opened)
  }

  const mobileMenuItems: ActionMenuItemProps[] = []

  if (conversationListMenu.pin) {
    mobileMenuItems.push({
      text: pinActionLabel || '',
      icon: session.starred ? IconPinnedFilled : IconPinned,
      onClick: () => {
        void updateSessionStore(session.id, { starred: !session.starred })
      },
    })
  }
  if (conversationListMenu.edit) {
    mobileMenuItems.push({
      text: t('Edit Conversation') || '',
      icon: IconEdit,
      onClick: () => {
        void editCurrentSession()
      },
    })
  }
  if (conversationListMenu.duplicate) {
    mobileMenuItems.push({
      text: t('Duplicate Conversation') || '',
      icon: IconCopy,
      disabled: copying,
      onClick: () => {
        void copyCurrentSession()
      },
    })
  }
  if (conversationListMenu.reorder) {
    mobileMenuItems.push({
      text: t('Adjust order') || '',
      icon: IconArrowsMoveVertical,
      disabled: !props.onStartReordering,
      onClick: props.onStartReordering,
    })
  }
  if (conversationListMenu.archive) {
    mobileMenuItems.push({
      text: archiveActionLabel || '',
      icon: IconArchive,
      disabled: archiving,
      onClick: () => {
        void archiveCurrentSession()
      },
    })
  }
  if (conversationListMenu.delete) {
    mobileMenuItems.push({
      text: t('Delete') || '',
      icon: IconTrash,
      color: 'chatbox-error',
      disabled: deleting,
      doubleCheck: {
        text: t('Confirm Delete?') || '',
        icon: IconTrash,
        color: 'chatbox-error',
      },
      onClick: () => {
        void deleteCurrentSession()
      },
    })
  }
  const hasMobileMenuItems = mobileMenuItems.length > 0

  const content = (
    <Flex
      align="center"
      className={clsx(
        'cursor-pointer rounded-sm group/session-item',
        'select-none',
        props.isReordering && 'cursor-default',
        isSmallScreen
          ? props.isReordering
            ? 'bg-chatbox-background-primary'
            : ''
          : selected
            ? 'bg-chatbox-background-brand-secondary'
            : 'hover:bg-chatbox-background-gray-secondary'
      )}
      h={48}
      mx="xs"
      pl="xs"
      pr={props.isReordering ? 44 : 'xs'}
      gap={10}
      onClick={onClick}
      onContextMenu={handleContextMenu}
      onPointerLeave={handlePointerLeave}
    >
      <AssistantAvatar
        avatarKey={session.assistantAvatarKey}
        picUrl={session.picUrl}
        sessionType={session.type}
        size="sm"
        type="chat"
        c={selected ? 'chatbox-brand' : 'chatbox-primary'}
      />

      <Text span flex={1} lineClamp={1} c={selected ? 'chatbox-brand' : 'chatbox-primary'}>
        {session.name}
      </Text>

      {isSmallScreen && !props.isReordering && hasMobileMenuItems && (
        <ActionIcon
          aria-label={t('More')}
          variant="transparent"
          size={24}
          color="chatbox-tertiary"
          onPointerDown={stopItemClick}
          onClick={(event) => {
            stopItemClick(event)
            setMobileMenuOpened(true)
          }}
        >
          <ScalableIcon icon={IconDotsVertical} className="text-inherit" size={17} />
        </ActionIcon>
      )}

      {!isSmallScreen && (
        <Text
          span
          c="chatbox-disabled"
          className="shrink-0 text-[10px] tabular-nums opacity-50 group-hover/session-item:hidden"
        >
          {formatSessionTime(session.createdAt)}
        </Text>
      )}

      <Flex gap={2} className={clsx(isSmallScreen ? 'hidden' : 'group-hover/session-item:flex hidden')}>
        <Tooltip label={pinActionLabel} openDelay={1000} withArrow disabled={actionTooltipDismissed}>
          <ActionIcon
            aria-label={pinActionLabel}
            variant="transparent"
            size={20}
            color={session.starred ? 'chatbox-brand' : 'chatbox-tertiary'}
            onPointerDown={stopItemClick}
            onClick={(event) => {
              stopItemClick(event)
              dismissActionTooltip()
              void updateSessionStore(session.id, { starred: !session.starred })
            }}
          >
            {session.starred ? (
              <ScalableIcon icon={IconPinnedFilled} className="text-inherit" size={16} />
            ) : (
              <ScalableIcon icon={IconPinned} className="text-inherit" size={16} />
            )}
          </ActionIcon>
        </Tooltip>

        <Tooltip label={archiveActionLabel} openDelay={1000} withArrow disabled={actionTooltipDismissed}>
          <ActionIcon
            aria-label={archiveActionLabel}
            variant="transparent"
            size={20}
            color="chatbox-tertiary"
            loading={archiving}
            onPointerDown={stopItemClick}
            onClick={async (event) => {
              stopItemClick(event)
              if (archiving) {
                return
              }
              dismissActionTooltip()
              await archiveCurrentSession()
            }}
          >
            <ScalableIcon icon={IconArchive} className="text-inherit" size={16} />
          </ActionIcon>
        </Tooltip>
      </Flex>
    </Flex>
  )

  if (!isSmallScreen || !hasMobileMenuItems) {
    return content
  }

  return (
    <ActionMenu
      type="contextual"
      trigger="manual"
      items={mobileMenuItems}
      opened={mobileMenuOpened}
      onChange={handleMobileMenuChange}
      position="bottom-end"
      offset={0}
    >
      {content}
    </ActionMenu>
  )
}

export default memo(SessionItem)
