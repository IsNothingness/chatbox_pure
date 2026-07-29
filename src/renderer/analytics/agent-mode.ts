import { isExpectedGenerationError } from '@shared/models/error-classification'
import platform from '@/platform'
import { trackEvent } from '@/utils/track'
import { trackJkAutoEvent, trackJkClickEvent } from './jk'
import { JK_EVENTS, JK_PAGE_NAMES } from './jk-events'

export type BooleanString = 'true' | 'false'

export type AgentModeEntrySource = 'suggestion_accept' | 'locked_session' | 'manual' | 'none'

export type AgentModeTrackingMode = 'chat_mode' | 'work_mode'

export type AgentModeTrackingContext = {
  sessionId: string
  mode: AgentModeTrackingMode
  provider?: string
  model?: string
}

export type AgentModeApprovalTarget = 'user_exec' | 'file_write' | 'file_edit'

function buildAgentModeBaseTrackingOptions(context: AgentModeTrackingContext) {
  return {
    pageName: JK_PAGE_NAMES.CHAT_PAGE,
    platform: platform.type === 'web' ? ('web' as const) : ('app' as const),
    props: {
      agent_info: {
        mode: context.mode,
        session_id: context.sessionId,
      },
    },
  }
}

function buildAgentModeTrackingOptions(
  context: AgentModeTrackingContext,
  content: string,
  agentInfo: Record<string, unknown> = {}
) {
  const baseOptions = buildAgentModeBaseTrackingOptions(context)
  return {
    ...baseOptions,
    content,
    contentType: context.model,
    props: {
      ...baseOptions.props,
      agent_info: {
        ...agentInfo,
        ...baseOptions.props.agent_info,
      },
      content_add_info: {
        content: context.provider ?? null,
      },
    },
  }
}

export function trackAgentModeSelect(context: AgentModeTrackingContext) {
  trackJkClickEvent(JK_EVENTS.AGENT_MODE_SELECT, buildAgentModeTrackingOptions(context, context.mode))
}

export function trackSmartSwitchingClick(context: AgentModeTrackingContext, enabled: boolean) {
  trackJkClickEvent(JK_EVENTS.SMART_SWITCHING_CLICK, buildAgentModeTrackingOptions(context, enabled ? 'on' : 'off'))
}

export function trackCodeExecutionClick(context: AgentModeTrackingContext, access: 'approval' | 'full_access') {
  trackJkClickEvent(JK_EVENTS.CODE_EXECUTION_CLICK, buildAgentModeTrackingOptions(context, access))
}

export function trackWorkModeSuggestionDecision(
  context: AgentModeTrackingContext,
  suggested: boolean,
  fileCount: number
) {
  trackJkAutoEvent(
    JK_EVENTS.WORK_MODE_SUGGEST,
    buildAgentModeTrackingOptions(context, toBooleanString(suggested), { file_count: fileCount })
  )
}

export function trackWebSearchClick(context: AgentModeTrackingContext, enabled: boolean, webSearchProvider: string) {
  trackJkClickEvent(
    JK_EVENTS.WEB_SEARCH_CLICK,
    buildAgentModeTrackingOptions(context, enabled ? 'on' : 'off', { content: webSearchProvider })
  )
}

export function trackAgentModeFreePointsCard(context: AgentModeTrackingContext) {
  const baseOptions = buildAgentModeBaseTrackingOptions(context)
  trackJkAutoEvent(JK_EVENTS.AGENT_MODE_FREE_POINTS_CARD, {
    ...baseOptions,
    props: {
      ...baseOptions.props,
      content_add_info: {
        content: context.provider ?? null,
      },
      ...(context.model ? { content_info: { type: context.model } } : {}),
    },
  })
}

export function trackAgentModeFreePointsCardClick(context: AgentModeTrackingContext) {
  trackJkClickEvent(
    JK_EVENTS.AGENT_MODE_FREE_POINTS_CARD_CLICK,
    buildAgentModeTrackingOptions(context, 'free_points_claim')
  )
}

export function trackAgentModeFreePointsClaimSuccess(context: AgentModeTrackingContext) {
  trackJkAutoEvent(JK_EVENTS.AGENT_MODE_FREE_POINTS_CLAIM_SUCCESS, buildAgentModeBaseTrackingOptions(context))
}

export function toBooleanString(value: boolean): BooleanString {
  return value ? 'true' : 'false'
}

export function bucketCount(count: number): '0' | '1' | '2_plus' {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  return '2_plus'
}

export function trackAgentModeSuggested(props: { hasFiles: boolean; fileCount: number }) {
  trackEvent('agent_mode_suggested', {
    has_files: toBooleanString(props.hasFiles),
    file_count: bucketCount(props.fileCount),
  })
}

export function trackAgentModeSuggestionAction(props: {
  action: 'accept' | 'decline'
  hasFiles: boolean
  fileCount: number
  context: AgentModeTrackingContext
}) {
  trackEvent('agent_mode_suggestion_action', {
    action: props.action,
    has_files: toBooleanString(props.hasFiles),
    file_count: bucketCount(props.fileCount),
  })
  trackJkClickEvent(JK_EVENTS.WORK_MODE_SUGGESTION_ACT, buildAgentModeTrackingOptions(props.context, props.action))
}

export function trackAgentModePauseAction(props: {
  type: 'approval' | 'tool_limit'
  action: 'approve' | 'deny' | 'continue' | 'stop'
  context?: AgentModeTrackingContext
  approvalTarget?: AgentModeApprovalTarget
}) {
  trackEvent('agent_mode_pause_action', {
    type: props.type,
    action: props.action,
  })

  if (props.type === 'approval' && props.context && props.approvalTarget) {
    trackJkClickEvent(
      JK_EVENTS.WORK_MODE_PAUSE_ACT,
      buildAgentModeTrackingOptions(props.context, props.action === 'approve' ? 'accept' : 'decline', {
        content: props.approvalTarget,
      })
    )
  }
}

export function trackAgentModeFullAccessBypass(props: { tool: 'user_exec' | 'write_file' | 'edit_file' }) {
  trackEvent('agent_mode_full_access_bypass', props)
}

// Same expected-error set as handleGenerationError: provider/network failures are
// user-environment noise, not defects, and their messages can echo request content.
export { isExpectedGenerationError }

export function captureAgentModeException(
  _error: unknown,
  _context: {
    operation:
      | 'suggestion'
      | 'suggestion_model'
      | 'generation'
      | 'tool_pause_continue'
      | 'tool_retry'
      | 'full_access_bypass'
    provider?: string
    model?: string
    agentMode?: string
    fullAccess?: boolean
    toolName?: string
    pauseType?: string
    operationType?: string
  }
) {
  // Pure builds intentionally keep handled errors local.
}
