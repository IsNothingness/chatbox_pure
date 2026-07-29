import { ActionIcon, Badge, Button, Divider, Flex, Group, Loader, Stack, Switch, Text, Tooltip } from '@mantine/core'
import type { AgentModeValue, KnowledgeBase } from '@shared/types'
import {
  IconCheck,
  IconChevronRight,
  IconCode,
  IconFile,
  IconFolderCog,
  IconHammer,
  IconSettings2,
  IconTrash,
  IconVocabulary,
  IconWand,
  IconWorldWww,
} from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { type FC, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  trackAgentModeSelect,
  trackCodeExecutionClick,
  trackSmartSwitchingClick,
  trackWebSearchClick,
} from '@/analytics/agent-mode'
import { useKnowledgeBases } from '@/hooks/knowledge-base'
import { useMCPServerStatus, useToggleMCPServer } from '@/hooks/mcp'
import { navigateToSettings } from '@/modals/Settings'
import { BUILTIN_MCP_SERVERS } from '@/packages/mcp/builtin'
import { skillsController, subscribeSkillsChanged } from '@/packages/skills/controller'
import { WEB_SEARCH_PROVIDERS, type WebSearchProviderValue } from '@/packages/web-search/constants'
import platform from '@/platform'
import * as chatStore from '@/stores/chatStore'
import { useSession, useSessionSettings } from '@/stores/chatStore'
import { useAutoValidate } from '@/stores/premiumActions'
import { setSessionAgentMode, useSessionAgentMode } from '@/stores/session/agent-mode'
import { useMcpSettings, useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { ScalableIcon } from '../common/ScalableIcon'
import MCPStatus from '../mcp/MCPStatus'
import { getAgentModeUIState } from './agentModeState'

type PanelPage = 'main' | 'web-search' | 'code-execution' | 'skills' | 'mcp' | 'knowledge-base' | 'working-directory'

// The working-directory feature needs the desktop filesystem and directory picker. Windows
// uses the native execution backend; bound directory writes are validated in the main process.
const supportsWorkingDirectories = platform.type === 'desktop' && !!platform.openDirectoryDialog

export interface AgentModePanelProps {
  sessionId: string
  providerId?: string
  modelId?: string
  modelSupportsAgentMode?: boolean
  webBrowsingMode: boolean
  onWebBrowsingChange: (enabled: boolean) => void
  currentKnowledgeBaseId?: number
  onKnowledgeBaseSelect: (kb: KnowledgeBase | null) => void
  onSkillSelect: (skillName: string) => void
  onClose: () => void
}

// --- Sub-components ---

const MCPServerItem: FC<{
  id: string
  name: string
  enabled: boolean
  disabled?: boolean
  onEnabledChange: (id: string, enabled: boolean) => void
}> = ({ id, name, enabled, disabled = false, onEnabledChange }) => {
  const status = useMCPServerStatus(id)
  return (
    <Flex
      justify="space-between"
      align="center"
      px="sm"
      py={6}
      className={`rounded ${
        disabled ? 'opacity-50' : 'hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
      }`}
    >
      <Flex gap="xs" align="center">
        <MCPStatus status={status} />
        <Text size="sm">{name}</Text>
      </Flex>
      <Switch
        checked={enabled}
        size="xs"
        disabled={disabled || status?.state === 'starting' || status?.state === 'stopping'}
        onChange={(e) => onEnabledChange(id, e.currentTarget.checked)}
      />
    </Flex>
  )
}

// --- Main component ---

const AgentModePanel: FC<AgentModePanelProps> = ({
  sessionId,
  providerId,
  modelId,
  modelSupportsAgentMode = true,
  webBrowsingMode,
  onWebBrowsingChange,
  currentKnowledgeBaseId,
  onKnowledgeBaseSelect,
  onSkillSelect,
  onClose,
}) => {
  const { t } = useTranslation()
  const [page, setPage] = useState<PanelPage>('main')
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const openTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const panelRef = useRef<HTMLDivElement>(null)
  const subPanelRef = useRef<HTMLDivElement>(null)
  const [subPanelAlign, setSubPanelAlign] = useState<'top' | 'bottom'>('bottom')
  const [subPanelTop, setSubPanelTop] = useState<number>(0)
  const isNewSession = sessionId === 'new'
  const { session: currentSession } = useSession(isNewSession ? null : sessionId)

  // Agent mode state
  const setAgentModeSmartSwitchingDefault = useUIStore((s) => s.setAgentModeSmartSwitchingDefault)
  const entry = useSessionAgentMode(sessionId)
  const agentModeUIState = useMemo(
    () => getAgentModeUIState(entry, modelSupportsAgentMode),
    [entry, modelSupportsAgentMode]
  )
  const capabilitiesDisabled = agentModeUIState.capabilitiesDisabled

  // Web Search state
  const webSearchProvider = useSettingsStore((s) => s.extension.webSearch.provider)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const tavilyApiKey = useSettingsStore((s) => s.extension.webSearch.tavilyApiKey)
  const bochaApiKey = useSettingsStore((s) => s.extension.webSearch.bochaApiKey)
  const queritApiKey = useSettingsStore((s) => s.extension.webSearch.queritApiKey)
  const webSearchProviderLabel =
    WEB_SEARCH_PROVIDERS.find((p) => p.value === webSearchProvider)?.label ?? webSearchProvider

  const isProviderAvailable = useCallback(
    (provider: WebSearchProviderValue) => {
      if (provider === 'tavily') return !!tavilyApiKey
      if (provider === 'bocha') return !!bochaApiKey
      if (provider === 'querit') return !!queritApiKey
      return true
    },
    [bochaApiKey, queritApiKey, tavilyApiKey]
  )

  // MCP state
  const mcp = useMcpSettings()
  const isPremium = useAutoValidate()
  const onMCPEnabledChange = useToggleMCPServer()
  const enabledMCPCount = mcp.servers.filter((s) => s.enabled).length + mcp.enabledBuiltinServers.length

  // Knowledge Base state
  const { data: knowledgeBases } = useKnowledgeBases()

  // Skills state
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsVersion, setSkillsVersion] = useState(0)
  const enabledSkillNames = useSettingsStore((s) => s.skills.enabledSkillNames)

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const allSkills = await skillsController.discoverSkills()
      setSkills(allSkills.map((s) => ({ name: s.name, description: s.description })))
    } catch {
      setSkills([])
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (page === 'skills') {
      void loadSkills()
    }
  }, [page, loadSkills, skillsVersion])

  useEffect(() => {
    return subscribeSkillsChanged(() => {
      setSkillsVersion((version) => version + 1)
    })
  }, [])

  const enabledSkills = useMemo(
    () => skills.filter((s) => enabledSkillNames.includes(s.name)),
    [skills, enabledSkillNames]
  )

  const handleModeChange = useCallback(
    (value: AgentModeValue) => {
      if (entry.value === value) return
      trackAgentModeSelect({
        sessionId,
        mode: value === 'on' ? 'work_mode' : 'chat_mode',
        provider: providerId,
        model: modelId,
      })
      void setSessionAgentMode(sessionId, value)
    },
    [entry.value, modelId, providerId, sessionId]
  )
  const handleSmartSwitchingChange = useCallback(
    (enabled: boolean) => {
      trackSmartSwitchingClick(
        {
          sessionId,
          mode: 'chat_mode',
          provider: providerId,
          model: modelId,
        },
        enabled
      )
      setAgentModeSmartSwitchingDefault(enabled)
      void setSessionAgentMode(sessionId, enabled ? 'auto' : 'off')
    },
    [modelId, providerId, sessionId, setAgentModeSmartSwitchingDefault]
  )

  // Working directories (desktop only): real local dirs the sandbox may read/write freely.
  // A brand-new chat (sessionId === 'new') is not yet persisted, so its binding is held in
  // newSessionState and transferred into the created session's settings on first submit
  // (see routes/index.tsx) — mirroring how knowledge base / web browsing are handled.
  const newSessionState = useUIStore((s) => s.newSessionState)
  const setNewSessionState = useUIStore((s) => s.setNewSessionState)
  const { sessionSettings } = useSessionSettings(sessionId)
  const workingDirectories = useMemo(
    () => (isNewSession ? (newSessionState.workingDirectories ?? []) : (sessionSettings.workingDirectories ?? [])),
    [isNewSession, newSessionState.workingDirectories, sessionSettings]
  )
  const agentFullAccess = isNewSession
    ? (newSessionState.agentFullAccess ?? false)
    : (sessionSettings.agentFullAccess ?? false)

  const updateWorkingDirectories = useCallback(
    async (next: string[]) => {
      const value = next.length ? next : undefined
      if (isNewSession) {
        setNewSessionState((prev) => ({ ...prev, workingDirectories: value }))
        return
      }
      try {
        await chatStore.updateSession(sessionId, (session) => {
          if (!session) {
            throw new Error('Session not found')
          }
          return { ...session, settings: { ...session.settings, workingDirectories: value } }
        })
      } catch (err) {
        console.error('Failed to update working directories:', err)
      }
    },
    [isNewSession, sessionId, setNewSessionState]
  )

  const handleAddWorkingDirectory = useCallback(async () => {
    if (!platform.openDirectoryDialog) return
    const result = await platform.openDirectoryDialog()
    if (result.canceled || !result.path || workingDirectories.includes(result.path)) return
    await updateWorkingDirectories([...workingDirectories, result.path])
  }, [workingDirectories, updateWorkingDirectories])

  const handleRemoveWorkingDirectory = useCallback(
    async (dir: string) => {
      await updateWorkingDirectories(workingDirectories.filter((item) => item !== dir))
    },
    [workingDirectories, updateWorkingDirectories]
  )

  const updateAgentFullAccess = useCallback(
    async (enabled: boolean) => {
      if (enabled === agentFullAccess) return
      trackCodeExecutionClick(
        {
          sessionId,
          mode: 'work_mode',
          provider: providerId,
          model: modelId,
        },
        enabled ? 'full_access' : 'approval'
      )
      const value = enabled || undefined
      if (isNewSession) {
        setNewSessionState((prev) => ({ ...prev, agentFullAccess: value }))
        return
      }
      try {
        await chatStore.updateSession(sessionId, (session) => {
          if (!session) {
            throw new Error('Session not found')
          }
          return { ...session, settings: { ...session.settings, agentFullAccess: value } }
        })
      } catch (err) {
        console.error('Failed to update agent full access:', err)
      }
    },
    [agentFullAccess, isNewSession, modelId, providerId, sessionId, setNewSessionState]
  )

  const selectedKB = useMemo(
    () => knowledgeBases?.find((kb) => kb.id === currentKnowledgeBaseId),
    [knowledgeBases, currentKnowledgeBaseId]
  )

  // Hover handlers for sub-panel with delay to prevent flicker
  const clearSubPanelCloseTimer = useCallback(() => {
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }, [])

  const clearSubPanelOpenTimer = useCallback(() => {
    clearTimeout(openTimerRef.current)
    openTimerRef.current = undefined
  }, [])

  const scheduleSubPanelClose = useCallback(
    (delay: number) => {
      clearSubPanelCloseTimer()
      clearSubPanelOpenTimer()
      closeTimerRef.current = setTimeout(() => {
        setPage('main')
        closeTimerRef.current = undefined
      }, delay)
    },
    [clearSubPanelCloseTimer, clearSubPanelOpenTimer]
  )

  const handleExtensionHover = useCallback(
    (target: PanelPage, e?: React.MouseEvent, align: 'top' | 'bottom' = 'bottom') => {
      clearSubPanelCloseTimer()
      clearSubPanelOpenTimer()

      let nextSubPanelTop = 0
      if (align === 'top' && e && panelRef.current) {
        const row = e.currentTarget as HTMLElement
        const panelRect = panelRef.current.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        nextSubPanelTop = rowRect.top - panelRect.top
      }

      const openTarget = () => {
        setPage(target)
        setSubPanelAlign(align)
        if (align === 'top') {
          setSubPanelTop(nextSubPanelTop)
        }
      }

      if (page === 'main' || page === target) {
        openTarget()
        return
      }

      openTimerRef.current = setTimeout(openTarget, 180)
    },
    [clearSubPanelCloseTimer, clearSubPanelOpenTimer, page]
  )

  const handleSubPanelEnter = useCallback(() => {
    clearSubPanelCloseTimer()
    clearSubPanelOpenTimer()
  }, [clearSubPanelCloseTimer, clearSubPanelOpenTimer])

  const handleSubPanelLeave = useCallback(() => {
    scheduleSubPanelClose(300)
  }, [scheduleSubPanelClose])

  const handleNonExtensionHover = useCallback(() => {
    scheduleSubPanelClose(200)
  }, [scheduleSubPanelClose])

  const resetSubPanel = useCallback(() => {
    clearSubPanelCloseTimer()
    clearSubPanelOpenTimer()
    setPage('main')
  }, [clearSubPanelCloseTimer, clearSubPanelOpenTimer])

  useEffect(() => {
    return () => {
      clearTimeout(closeTimerRef.current)
      clearTimeout(openTimerRef.current)
    }
  }, [])

  useEffect(() => {
    subPanelRef.current?.scrollTo({ top: 0 })
  }, [page])

  // --- Mode button ---
  const ModeButton: FC<{ value: Extract<AgentModeValue, 'on' | 'off'>; label: string }> = ({ value, label }) => {
    const isActive = agentModeUIState.displayValue === value
    const isLockedDisabled = entry.locked && value !== 'on'
    const isModelDisabled = !modelSupportsAgentMode && value !== 'off'
    const isDisabled = isLockedDisabled || isModelDisabled
    const tooltipLabel = isModelDisabled
      ? t('This model does not support Agent Mode')
      : t('Locked after the chat starts to keep tools and context consistent — start a new chat to change')
    return (
      <Tooltip label={tooltipLabel} disabled={!isDisabled} withArrow>
        <Button
          size="xs"
          variant={isActive ? 'filled' : 'default'}
          color={isActive ? 'chatbox-brand' : undefined}
          fullWidth
          disabled={isDisabled}
          onClick={() => handleModeChange(value)}
        >
          {label}
        </Button>
      </Tooltip>
    )
  }

  const isChatModeSelected = agentModeUIState.displayValue === 'off'
  const smartSwitchingEnabled = entry.value === 'auto' && isChatModeSelected
  const smartSwitchingExpired =
    !isNewSession && Boolean(currentSession?.messages.some((message) => message.role === 'user'))
  const isSmartSwitchingDisabled = entry.locked || !modelSupportsAgentMode || smartSwitchingExpired
  const modeDescription = agentModeUIState.isActive
    ? t('Best for multi-step tasks with files, code execution, tools, MCP, skills, or knowledge bases.')
    : t('Best for quick Q&A, writing, translation, explanations, and web search.')
  const smartSwitchingDescription = smartSwitchingExpired
    ? t('Only available before the first message.')
    : t('Suggest Work Mode on the first message.')

  // --- Extension row ---
  const ExtensionRow: FC<{
    icon: React.ReactNode
    label: string
    badge?: string | number
    subtitle?: string
    active?: boolean
    page: PanelPage
    rightContent?: React.ReactNode
    subPanelAlign?: 'top' | 'bottom'
    disabled?: boolean
  }> = ({
    icon,
    label,
    badge,
    subtitle,
    active,
    page: targetPage,
    rightContent,
    subPanelAlign = 'bottom',
    disabled = false,
  }) => (
    <Flex
      justify="space-between"
      align="center"
      px="sm"
      py={6}
      tabIndex={0}
      role="button"
      aria-expanded={active}
      aria-disabled={disabled}
      className={`rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--chatbox-tint-brand)] ${
        active
          ? 'bg-[var(--mantine-color-gray-1)] dark:bg-[var(--mantine-color-dark-5)]'
          : 'hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
      } ${disabled ? '' : 'cursor-pointer'}`}
      onMouseEnter={(e) => handleExtensionHover(targetPage, e, subPanelAlign)}
      onMouseLeave={clearSubPanelOpenTimer}
      onFocus={(e) => handleExtensionHover(targetPage, e as unknown as React.MouseEvent, subPanelAlign)}
      onBlur={handleSubPanelLeave}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleExtensionHover(targetPage, e as unknown as React.MouseEvent, subPanelAlign)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          resetSubPanel()
        }
      }}
    >
      <Flex gap="xs" align="center" className="min-w-0">
        {icon}
        <Text size="sm">{label}</Text>
        {badge !== undefined && (
          <Badge size="xs" variant="light">
            {badge}
          </Badge>
        )}
        {subtitle && (
          <Text size="xs" c="dimmed" truncate className="max-w-[100px]">
            {subtitle}
          </Text>
        )}
      </Flex>
      {rightContent ?? <IconChevronRight size={14} className="text-[var(--chatbox-tint-tertiary)] shrink-0" />}
    </Flex>
  )

  // --- Sub-panel header ---
  const SubPanelHeader: FC<{ title: string; settingsPath?: string; disabled?: boolean }> = ({
    title,
    settingsPath,
    disabled = false,
  }) => (
    <Flex justify="space-between" align="center" px="sm" py="xs">
      <Text fw={600} size="sm">
        {title}
      </Text>
      {settingsPath && (
        <ActionIcon
          variant="subtle"
          size={20}
          disabled={disabled}
          onClick={() => {
            if (disabled) return
            onClose()
            navigateToSettings(settingsPath)
          }}
        >
          <ScalableIcon icon={IconSettings2} size={16} color="var(--chatbox-tint-tertiary)" />
        </ActionIcon>
      )}
    </Flex>
  )

  const handleWebSearchProviderChange = useCallback(
    (provider: WebSearchProviderValue) => {
      setSettings((draft) => {
        draft.extension.webSearch.provider = provider
      })
    },
    [setSettings]
  )

  // --- Sub-panel content ---
  const renderSubPanel = () => {
    if (page === 'web-search') {
      return (
        <>
          <SubPanelHeader title={t('Web Search')} settingsPath="/web-search" disabled={capabilitiesDisabled} />
          <Divider my={4} />
          {WEB_SEARCH_PROVIDERS.map((provider) => {
            const available = isProviderAvailable(provider.value)
            const isSelected = webSearchProvider === provider.value
            const isDisabled = capabilitiesDisabled || !available
            return (
              <Tooltip
                key={provider.value}
                label={t('Configure in Settings')}
                disabled={capabilitiesDisabled || available}
                withArrow
                position="right"
              >
                <Flex
                  justify="space-between"
                  align="center"
                  px="sm"
                  py={6}
                  className={`rounded ${
                    !isDisabled
                      ? 'cursor-pointer hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
                      : 'cursor-default opacity-50'
                  }`}
                  onClick={() => {
                    if (capabilitiesDisabled) {
                      return
                    }
                    if (available) {
                      handleWebSearchProviderChange(provider.value)
                    } else {
                      onClose()
                      navigateToSettings('/web-search')
                    }
                  }}
                >
                  <Text size="sm" c={isSelected ? 'chatbox-brand' : available ? '' : 'dimmed'}>
                    {provider.label}
                  </Text>
                  {isSelected && <IconCheck size={14} color="var(--chatbox-tint-brand)" />}
                </Flex>
              </Tooltip>
            )
          })}
        </>
      )
    }

    if (page === 'code-execution') {
      return (
        <>
          <SubPanelHeader title={t('Code Execution')} disabled={capabilitiesDisabled} />
          <Divider my={4} />
          <Flex
            justify="space-between"
            align="center"
            px="sm"
            py={6}
            gap="sm"
            className={`rounded ${
              capabilitiesDisabled
                ? 'cursor-default opacity-50'
                : 'cursor-pointer hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
            }`}
            onClick={() => {
              if (capabilitiesDisabled) return
              void updateAgentFullAccess(false)
            }}
          >
            <Stack gap={0} className="min-w-0">
              <Text size="sm" c={!agentFullAccess ? 'chatbox-brand' : undefined}>
                {t('Approve')}
              </Text>
              <Text size="xs" c="chatbox-secondary" className="leading-snug">
                {t('Ask before running commands or changing files.')}
              </Text>
            </Stack>
            {!agentFullAccess && <IconCheck size={14} className="text-[var(--chatbox-tint-brand)] shrink-0" />}
          </Flex>
          <Flex
            justify="space-between"
            align="center"
            px="sm"
            py={6}
            gap="sm"
            className={`rounded ${
              capabilitiesDisabled
                ? 'cursor-default opacity-50'
                : 'cursor-pointer hover:bg-red-50 dark:hover:bg-red-950/30'
            }`}
            onClick={() => {
              if (capabilitiesDisabled) return
              void updateAgentFullAccess(true)
            }}
          >
            <Stack gap={0} className="min-w-0">
              <Text size="sm" c="red" fw={500}>
                {t('Full Access')}
              </Text>
              <Text size="xs" c="red" className="leading-snug">
                {t('Skip approval prompts for commands and file changes.')}
              </Text>
            </Stack>
            {agentFullAccess && <IconCheck size={14} className="text-red-600 shrink-0" />}
          </Flex>
        </>
      )
    }

    if (page === 'skills') {
      return (
        <>
          <SubPanelHeader title="Skills" settingsPath="/skills" disabled={capabilitiesDisabled} />
          <Divider my={4} />
          {skillsLoading ? (
            <Flex justify="center" py="md">
              <Loader size="sm" />
            </Flex>
          ) : enabledSkills.length > 0 ? (
            enabledSkills.map((skill) => (
              <Flex
                key={skill.name}
                px="sm"
                py={6}
                className={`rounded ${
                  capabilitiesDisabled
                    ? 'cursor-default opacity-50'
                    : 'cursor-pointer hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
                }`}
                gap="xs"
                align="center"
                onClick={() => {
                  if (capabilitiesDisabled) return
                  onSkillSelect(skill.name)
                  onClose()
                }}
              >
                <IconWand size={14} className="text-[var(--chatbox-tint-tertiary)] shrink-0" />
                <Stack gap={0} className="min-w-0">
                  <Text size="sm" truncate>
                    /{skill.name}
                  </Text>
                  {skill.description && (
                    <Text size="xs" c="dimmed" truncate>
                      {skill.description}
                    </Text>
                  )}
                </Stack>
              </Flex>
            ))
          ) : (
            <Group justify="center" py="md">
              <Button
                size="xs"
                variant="light"
                disabled={capabilitiesDisabled}
                onClick={() => {
                  if (capabilitiesDisabled) return
                  onClose()
                  navigateToSettings('/skills')
                }}
              >
                <PlusIcon size={14} className="mr-1" />
                {t('Add Skills')}
              </Button>
            </Group>
          )}
        </>
      )
    }

    if (page === 'mcp') {
      return (
        <>
          <SubPanelHeader title="MCP" settingsPath="/mcp" disabled={capabilitiesDisabled} />
          <Divider my={4} />
          {isPremium && (
            <>
              {BUILTIN_MCP_SERVERS.map((server) => (
                <MCPServerItem
                  key={server.id}
                  id={server.id}
                  name={server.name}
                  enabled={mcp.enabledBuiltinServers.includes(server.id)}
                  disabled={capabilitiesDisabled}
                  onEnabledChange={onMCPEnabledChange}
                />
              ))}
              {mcp.servers.length > 0 && <Divider my={4} />}
            </>
          )}
          {mcp.servers.map((server) => (
            <MCPServerItem
              key={server.id}
              id={server.id}
              name={server.name}
              enabled={server.enabled}
              disabled={capabilitiesDisabled}
              onEnabledChange={onMCPEnabledChange}
            />
          ))}
          {!mcp.servers.length && !mcp.enabledBuiltinServers.length && (
            <Group justify="center" py="md">
              <Button
                size="xs"
                variant="light"
                disabled={capabilitiesDisabled}
                onClick={() => {
                  if (capabilitiesDisabled) return
                  onClose()
                  navigateToSettings('/mcp')
                }}
              >
                <PlusIcon size={14} className="mr-1" />
                {t('Add your first MCP server')}
              </Button>
            </Group>
          )}
        </>
      )
    }

    if (page === 'knowledge-base') {
      return (
        <>
          <SubPanelHeader title={t('Knowledge Base')} settingsPath="/knowledge-base" disabled={capabilitiesDisabled} />
          <Divider my={4} />
          {knowledgeBases && knowledgeBases.length > 0 ? (
            knowledgeBases.map((kb) => (
              <Flex
                key={kb.id}
                justify="space-between"
                align="center"
                px="sm"
                py={6}
                className={`rounded ${
                  capabilitiesDisabled
                    ? 'cursor-default opacity-50'
                    : 'cursor-pointer hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]'
                }`}
                onClick={() => {
                  if (capabilitiesDisabled) return
                  onKnowledgeBaseSelect(kb.id === currentKnowledgeBaseId ? null : kb)
                  onClose()
                }}
              >
                <Flex gap="xs" align="center">
                  <IconFile size={14} />
                  <Text size="sm" c={kb.id === currentKnowledgeBaseId ? 'chatbox-brand' : ''}>
                    {kb.name}
                  </Text>
                </Flex>
                {kb.id === currentKnowledgeBaseId && <IconCheck size={14} color="var(--chatbox-tint-brand)" />}
              </Flex>
            ))
          ) : (
            <Group justify="center" py="md">
              <Link
                to="/settings/knowledge-base"
                onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                  if (capabilitiesDisabled) {
                    e.preventDefault()
                  }
                }}
              >
                <Button
                  size="xs"
                  variant="light"
                  disabled={capabilitiesDisabled}
                  onClick={() => {
                    if (capabilitiesDisabled) return
                    onClose()
                  }}
                >
                  <PlusIcon size={14} className="mr-1" />
                  {t('Create')}
                </Button>
              </Link>
            </Group>
          )}
        </>
      )
    }

    if (page === 'working-directory') {
      return (
        <>
          <SubPanelHeader title={t('Working Directory')} disabled={capabilitiesDisabled} />
          <Divider my={4} />
          <Text size="xs" c="dimmed" px="sm" pb={4}>
            {t('Grant the agent read/write access to local folders without per-action approval.')}
          </Text>
          {workingDirectories.map((dir) => (
            <Flex key={dir} justify="space-between" align="center" px="sm" py={6} gap="xs">
              <Flex gap="xs" align="center" className="min-w-0">
                <IconFile size={14} className="text-[var(--chatbox-tint-tertiary)] shrink-0" />
                <Tooltip label={dir} withArrow position="right" openDelay={400}>
                  <Text size="sm" truncate className="min-w-0">
                    {dir.split('/').filter(Boolean).pop() || dir}
                  </Text>
                </Tooltip>
              </Flex>
              <ActionIcon
                variant="subtle"
                size={20}
                color="red"
                disabled={capabilitiesDisabled}
                aria-label={t('Remove')}
                onClick={() => {
                  if (capabilitiesDisabled) return
                  void handleRemoveWorkingDirectory(dir)
                }}
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Flex>
          ))}
          <Group justify="center" py="md">
            <Button
              size="xs"
              variant="light"
              disabled={capabilitiesDisabled}
              onClick={() => {
                if (capabilitiesDisabled) return
                void handleAddWorkingDirectory()
              }}
            >
              <PlusIcon size={14} className="mr-1" />
              {t('Add Folder')}
            </Button>
          </Group>
        </>
      )
    }

    return null
  }

  // ==================== RENDER ====================
  return (
    <div
      className="relative"
      ref={panelRef}
      onMouseLeave={resetSubPanel}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && page === 'main') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      {/* Main panel - always visible */}
      <Stack gap={0} py="xs" className="w-[228px]">
        {/* Header: mode switcher */}
        <Stack gap="xs" px="sm" py="xs" onMouseEnter={handleNonExtensionHover}>
          <Text fw={600} size="sm" c="chatbox-primary">
            {t('Mode')}
          </Text>
          <Flex gap={6}>
            <ModeButton value="off" label={t('Chat Mode')} />
            <ModeButton value="on" label={t('Work Mode')} />
          </Flex>
          <Text size="xs" c="chatbox-secondary" className="leading-snug">
            {modeDescription}
          </Text>
          {isChatModeSelected && (
            <Flex
              justify="space-between"
              align="center"
              gap="sm"
              className="rounded-md bg-chatbox-background-secondary px-2 py-1.5"
            >
              <Stack gap={0} className="min-w-0">
                <Text size="xs" fw={500} c="chatbox-primary">
                  {t('Smart Switching')}
                </Text>
                <Text size="xs" c="chatbox-secondary" className="leading-snug">
                  {smartSwitchingDescription}
                </Text>
              </Stack>
              <Switch
                size="xs"
                checked={smartSwitchingEnabled}
                disabled={isSmartSwitchingDisabled}
                onChange={(e) => handleSmartSwitchingChange(e.currentTarget.checked)}
              />
            </Flex>
          )}
        </Stack>

        {/* Capabilities - always visible, disabled when off */}
        <div style={capabilitiesDisabled ? { opacity: 0.5 } : undefined}>
          {/* Built-in capabilities */}
          <Divider my={4} mx="sm" label={t('Built-in')} labelPosition="left" />

          <ExtensionRow
            icon={<IconWorldWww size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label={t('Web Search')}
            subtitle={webBrowsingMode ? webSearchProviderLabel : undefined}
            active={page === 'web-search'}
            page="web-search"
            disabled={capabilitiesDisabled}
            subPanelAlign="top"
            rightContent={
              <Flex gap="xs" align="center" className="shrink-0">
                <Switch
                  checked={webBrowsingMode}
                  size="xs"
                  disabled={capabilitiesDisabled}
                  onChange={(e) => {
                    e.stopPropagation()
                    const enabled = e.currentTarget.checked
                    trackWebSearchClick(
                      {
                        sessionId,
                        mode: 'work_mode',
                        provider: providerId,
                        model: modelId,
                      },
                      enabled,
                      webSearchProvider
                    )
                    onWebBrowsingChange(enabled)
                  }}
                />
                <IconChevronRight size={14} className="text-[var(--chatbox-tint-tertiary)]" />
              </Flex>
            }
          />

          <ExtensionRow
            icon={<IconCode size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label={t('Code Execution')}
            active={page === 'code-execution'}
            page="code-execution"
            disabled={capabilitiesDisabled}
            subPanelAlign="top"
            rightContent={
              <Flex gap="xs" align="center" className="shrink-0">
                {agentFullAccess ? (
                  <Badge size="xs" variant="light" color="red">
                    {t('Full Access')}
                  </Badge>
                ) : (
                  <Badge size="xs" variant="light">
                    {t('Approve')}
                  </Badge>
                )}
                <IconChevronRight size={14} className="text-[var(--chatbox-tint-tertiary)]" />
              </Flex>
            }
          />

          {/* Extensions */}
          <Divider my={4} mx="sm" label={t('Extensions')} labelPosition="left" />

          <ExtensionRow
            icon={<IconWand size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label="Skills"
            badge={enabledSkillNames.length > 0 ? enabledSkillNames.length : undefined}
            active={page === 'skills'}
            page="skills"
            disabled={capabilitiesDisabled}
          />

          <ExtensionRow
            icon={<IconHammer size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label="MCP"
            badge={enabledMCPCount > 0 ? enabledMCPCount : undefined}
            active={page === 'mcp'}
            page="mcp"
            disabled={capabilitiesDisabled}
          />

          <ExtensionRow
            icon={<IconVocabulary size={16} className="text-[var(--chatbox-tint-secondary)]" />}
            label={t('Knowledge Base')}
            subtitle={selectedKB?.name}
            active={page === 'knowledge-base'}
            page="knowledge-base"
            disabled={capabilitiesDisabled}
          />

          {supportsWorkingDirectories && (
            <ExtensionRow
              icon={<IconFolderCog size={16} className="text-[var(--chatbox-tint-secondary)]" />}
              label={t('Working Directory')}
              badge={workingDirectories.length > 0 ? workingDirectories.length : undefined}
              active={page === 'working-directory'}
              page="working-directory"
              disabled={capabilitiesDisabled}
            />
          )}
        </div>
      </Stack>

      {/* Sub panel - absolutely positioned to the right */}
      {page !== 'main' && (
        <Stack
          key={page}
          ref={subPanelRef}
          gap={0}
          py="xs"
          className="absolute left-full w-[240px] max-h-[360px] overflow-y-auto bg-[var(--mantine-color-body)] rounded-r-lg shadow-lg border-l border-[var(--mantine-color-default-border)]"
          style={subPanelAlign === 'top' ? { top: subPanelTop } : { bottom: 0 }}
          onMouseEnter={handleSubPanelEnter}
        >
          {renderSubPanel()}
        </Stack>
      )}
    </div>
  )
}

export default AgentModePanel
