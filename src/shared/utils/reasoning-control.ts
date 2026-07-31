import { isDeepSeekReasoningModel } from '../models/utils/deepseek'
import type { ModelProvider, ProviderModelInfo, ProviderOptions } from '../types'
import { ModelProviderEnum } from '../types'
import {
  canDisableGoogleThinking,
  type GoogleThinkingLevel,
  getGoogleThinkingMode,
  getSupportedGoogleThinkingLevels,
} from './google-thinking'

// 'default' sends no reasoning-related parameters at all (the provider's server-side
// default applies); 'off' force-sends the provider's explicit disable parameters.
export type ReasoningPresetLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ReasoningControlLevel = 'default' | 'off' | ReasoningPresetLevel | 'custom'

export type ReasoningControlDisabledReason =
  | 'requires-anthropic-api-style'
  | 'requires-google-api-style'
  | 'requires-openai-api-style'
  | 'requires-deepseek-api-style'
  | 'requires-qwen-api-style'
  | 'requires-xai-api-style'

export interface ReasoningControlCapabilities {
  supported: boolean
  kind:
    | 'anthropic-adaptive-effort'
    | 'anthropic-effort'
    | 'budget'
    | 'custom-effort'
    | 'deepseek-effort'
    | 'level'
    | 'openai-effort'
    | 'openrouter-reasoning'
    | 'toggle'
    | 'xai-effort'
  disabledReason?: ReasoningControlDisabledReason
}

export interface ReasoningControlOption {
  level: ReasoningControlLevel
  label: 'default' | 'off' | 'on' | ReasoningPresetLevel | 'custom'
}

const DEFAULT_CAPABILITIES: ReasoningControlCapabilities = {
  supported: false,
  kind: 'toggle',
}

type BudgetReasoningLevel = 'low' | 'medium' | 'high'

const CLAUDE_BUDGET_BY_LEVEL: Record<BudgetReasoningLevel, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
}

const GEMINI_BUDGET_BY_LEVEL: Record<BudgetReasoningLevel, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
}

const QWEN_THINKING_BUDGET_BY_LEVEL: Record<BudgetReasoningLevel, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
}

const GPT_EFFORT_MODELS = [/(?:^|\/)gpt-5(?:[.-]|$)/i, /(?:^|\/)gpt-oss(?:[.-]|$)/i, /(?:^|\/)o[1-9](?:[.-]|$)/i]
// o-series models only accept reasoning_effort low/medium/high — there is no
// minimal/none, so reasoning cannot be turned off for them.
const OPENAI_NO_DISABLE_MODELS = [/(?:^|\/)o[1-9](?:[.-]|$)/i, /(?:^|\/)gpt-oss(?:[.-]|$)/i]
// Chat-tuned gpt-5 variants (gpt-5-chat-latest, gpt-5.1-chat, gpt-5.2-chat-latest, ...)
// are non-reasoning models; sending reasoning_effort to them is rejected upstream
// ("Unrecognized request argument supplied: reasoning_effort").
const GPT_NON_REASONING_CHAT_MODELS = [/(?:^|\/)gpt-5[\w.-]*[.-]chat(?:[.-]|$)/i]
// o1-preview and o1-mini predate the reasoning_effort parameter — the API rejects it
// for them entirely, so they must not get effort controls at all.
const OPENAI_NO_EFFORT_PARAM_MODELS = [/(?:^|\/)o1-(?:preview|mini)(?:[.-]|$)/i]
// gpt-5.1 and later accept reasoning_effort: 'none'; the original gpt-5 only goes
// down to 'minimal'. Match any dotted gpt-5.x so future versions default to 'none'.
const OPENAI_NONE_EFFORT_MODELS = [/(?:^|\/)gpt-5\.[1-9]\d*(?:[.-]|$)/i]
const CLAUDE_EFFORT_MODELS = [/(?:^|\/)claude-opus-4[.-]5/i]
const CLAUDE_ADAPTIVE_EFFORT_MODELS = [
  /(?:^|\/)claude-(?:opus|sonnet)-4[.-](?:6|7|8)/i,
  /(?:^|\/)claude-(?:fable|mythos|opus|sonnet)-5(?:[.-]|$)/i,
  /(?:^|\/)claude-mythos-preview(?:[.-]|$)/i,
]
const CLAUDE_BUDGET_MODELS = [
  /(?:^|\/)claude-3-7-sonnet/i,
  /(?:^|\/)claude-sonnet-4(?![.-]?6)/i,
  /(?:^|\/)claude-haiku-4[.-]5/i,
  /(?:^|\/)claude-opus-4(?![.-]?(?:5|6|7|8))/i,
]
const QWEN_THINKING_MODELS = [/^qwen3/i, /(?:^|\/)qwen3/i]
const QWEN_THINKING_ONLY_MODELS = [
  /(?:^|\/)qwen3\.8(?:[.-]|$)/i,
  /(?:^|\/)qwen3\.7-max-preview(?:[.-]|$)/i,
  /(?:^|\/)qwen3\.7-max-2026-05-17(?:[.-]|$)/i,
  /(?:^|\/)qwen3[\w.-]*-thinking(?:[.-]|$)/i,
]
const GROK_REASONING_EFFORT_MODELS = [
  /(?:^|\/)grok-4\.5(?:-latest)?$/i,
  /(?:^|\/)grok-4\.20-multi-agent(?:-latest)?$/i,
  /(?:^|\/)grok-4\.3(?:-latest)?$/i,
  /(?:^|\/)grok-4(?:-latest|-0709)?$/i,
  /(?:^|\/)grok-4-fast(?:-reasoning)?(?:-latest)?$/i,
  /(?:^|\/)grok-4-1-fast(?:-reasoning)?(?:-latest)?$/i,
]

const REASONING_PRESET_LEVELS: readonly ReasoningPresetLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function matchesAny(modelId: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(modelId))
}

// Models whose thinking cannot be force-disabled do not get an 'off' option; selecting
// 'off' for them falls back to 'default' (send nothing). Claude effort/adaptive models
// are only controlled via the effort request param — the AI SDK never emits
// `thinking: {type: 'disabled'}`, so an explicit off cannot be expressed on the wire.
// Gemini 2.5 Pro enforces a minimum thinking budget, so thinkingBudget: 0 is rejected.
function supportsExplicitDisable(
  kind: ReasoningControlCapabilities['kind'],
  effectiveProvider: ModelProvider | undefined,
  modelId: string,
  mandatory = false
): boolean {
  if (mandatory) return false
  if (effectiveProvider === ModelProviderEnum.Gemini && !canDisableGoogleThinking(modelId)) {
    return false
  }
  if (kind === 'anthropic-adaptive-effort' || kind === 'anthropic-effort') {
    return false
  }
  if (kind === 'custom-effort' || kind === 'xai-effort') {
    return false
  }
  if (
    (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) &&
    matchesAny(modelId, QWEN_THINKING_ONLY_MODELS)
  ) {
    return false
  }
  if (isOpenAIStyleEffectiveProvider(effectiveProvider) && matchesAny(modelId, OPENAI_NO_DISABLE_MODELS)) {
    return false
  }
  if (
    isOpenAIStyleEffectiveProvider(effectiveProvider) &&
    isGptEffortModel(modelId) &&
    !matchesAny(modelId, OPENAI_NONE_EFFORT_MODELS)
  ) {
    return false
  }
  return true
}

function isGptEffortModel(modelId: string): boolean {
  return (
    matchesAny(modelId, GPT_EFFORT_MODELS) &&
    !matchesAny(modelId, GPT_NON_REASONING_CHAT_MODELS) &&
    !matchesAny(modelId, OPENAI_NO_EFFORT_PARAM_MODELS)
  )
}

function getOpenAIReasoningLevels(modelId: string): ReasoningPresetLevel[] {
  const id = modelId.toLowerCase()
  if (/(?:^|\/)gpt-5\.6(?:[.-]|$)/.test(id)) {
    return ['low', 'medium', 'high', 'xhigh', 'max']
  }
  if (/(?:^|\/)gpt-5\.(?:4|5)(?:[.-]|$)/.test(id)) {
    return ['low', 'medium', 'high', 'xhigh']
  }
  if (/(?:^|\/)gpt-5\.[1-3](?:[.-]|$)/.test(id)) {
    return ['low', 'medium', 'high']
  }
  if (/(?:^|\/)gpt-5(?:[.-]|$)/.test(id)) {
    return ['minimal', 'low', 'medium', 'high']
  }
  return ['low', 'medium', 'high']
}

function getClaudeReasoningLevels(modelId: string): ReasoningPresetLevel[] {
  if (matchesAny(modelId, CLAUDE_EFFORT_MODELS)) {
    return ['low', 'medium', 'high']
  }
  if (/(?:^|\/)claude-(?:opus|sonnet)-4[.-]6/i.test(modelId)) {
    return ['low', 'medium', 'high', 'max']
  }
  if (matchesAny(modelId, CLAUDE_ADAPTIVE_EFFORT_MODELS)) {
    return ['low', 'medium', 'high', 'xhigh', 'max']
  }
  return ['low', 'medium', 'high']
}

function getDeepSeekReasoningLevels(modelId: string): ReasoningPresetLevel[] {
  if (/(?:^|\/)deepseek-v4-pro(?:[.-]|$)/i.test(modelId)) {
    // The official API currently maps both low and high to high for V4 Pro.
    return ['high', 'max']
  }
  if (/(?:^|\/)deepseek-v4-flash(?:[.-]|$)/i.test(modelId)) {
    return ['low', 'high', 'max']
  }
  return ['high']
}

function getXAIReasoningLevels(modelId: string): ReasoningPresetLevel[] {
  if (/(?:^|\/)grok-4\.20-multi-agent(?:-latest)?$/i.test(modelId)) {
    return ['low', 'medium', 'high', 'xhigh']
  }
  return ['low', 'medium', 'high']
}

function normalizeAdvertisedEfforts(values: string[] | null | undefined): ReasoningPresetLevel[] | undefined {
  if (values === null) return [...REASONING_PRESET_LEVELS]
  if (!values) return undefined
  const supported = new Set(values.map((value) => value.toLowerCase()))
  return REASONING_PRESET_LEVELS.filter((level) => supported.has(level))
}

/**
 * Claude models that use adaptive thinking effort instead of a token budget.
 * Shared with the Claude provider so capability detection and request
 * construction stay in sync.
 */
export function isClaudeAdaptiveThinkingModel(modelId: string): boolean {
  return matchesAny(modelId, CLAUDE_ADAPTIVE_EFFORT_MODELS)
}

/**
 * Claude models whose thinking is controlled by the effort request param
 * (Opus 4.5 and the adaptive 4.7/4.8 generation) rather than a token budget.
 */
export function usesClaudeEffortControl(modelId: string): boolean {
  return matchesAny(modelId, [...CLAUDE_EFFORT_MODELS, ...CLAUDE_ADAPTIVE_EFFORT_MODELS])
}

/**
 * Drops Claude reasoning options written for a different model generation so they are
 * never sent on the wire: effort/adaptive models only accept the effort param, while
 * budget-style models only accept the thinking config. Without this, options persisted
 * on a session leak through model switches (e.g. a Sonnet thinking budget sent to an
 * adaptive Opus model) and contradict the 'default' (send nothing) level readback.
 */
export function normalizeClaudeReasoningOptions(
  modelId: string,
  claude: ProviderOptions['claude']
): ProviderOptions['claude'] {
  if (!claude) return undefined
  if (usesClaudeEffortControl(modelId)) {
    return claude.effort ? { effort: claude.effort } : undefined
  }
  return claude.thinking ? { thinking: claude.thinking } : undefined
}

/**
 * Whether a reasoning_effort value can be sent to the given OpenAI-style model:
 * o1-preview/o1-mini reject the parameter entirely, and the other o-series models
 * reject the minimal/none off values.
 */
export function isOpenAIReasoningEffortSupported(modelId: string, effort: string): boolean {
  if (matchesAny(modelId, OPENAI_NO_EFFORT_PARAM_MODELS)) return false
  if (matchesAny(modelId, OPENAI_NO_DISABLE_MODELS) && (effort === 'minimal' || effort === 'none')) return false
  if (effort === 'none' && !matchesAny(modelId, OPENAI_NONE_EFFORT_MODELS)) return false
  if (
    isGptEffortModel(modelId) &&
    REASONING_PRESET_LEVELS.includes(effort as ReasoningPresetLevel) &&
    !getOpenAIReasoningLevels(modelId).includes(effort as ReasoningPresetLevel)
  ) {
    return false
  }
  return true
}

/**
 * Drops OpenAI reasoning options the target model cannot accept (see
 * isOpenAIReasoningEffortSupported) — a stale off effort persisted under a GPT-5
 * session must not survive a switch to an o-series model. Returns undefined when the
 * options are invalid for the model, dropping the whole (reasoning-only) namespace.
 */
export function normalizeOpenAIReasoningOptions(
  modelId: string,
  openai: ProviderOptions['openai']
): ProviderOptions['openai'] {
  if (!openai) return undefined
  if (matchesAny(modelId, OPENAI_NO_EFFORT_PARAM_MODELS)) {
    return undefined
  }
  if (openai.reasoningEffort !== undefined && !isOpenAIReasoningEffortSupported(modelId, openai.reasoningEffort)) {
    return undefined
  }
  return openai
}

/**
 * Select the OpenAI reasoning options that have a defined OpenAI-compatible wire mapping.
 * `@ai-sdk/openai-compatible` forwards unknown keys verbatim, so OpenAI-only flags such as
 * forceReasoning, reasoningSummary and include must never cross this boundary.
 *
 * Keep this whitelist in sync with the OpenAI option writers in getReasoningProviderOptions.
 * Add a key here only after its compatible request-body mapping is verified.
 */
export function pickOpenAICompatibleReasoningOptions(
  modelId: string,
  providerOptions: ProviderOptions | undefined
): ProviderOptions['openaiCompatible'] {
  const reasoningEffort = providerOptions?.openai?.reasoningEffort ?? providerOptions?.openaiCompatible?.reasoningEffort
  const thinking = providerOptions?.openaiCompatible?.thinking
  if (reasoningEffort === undefined && thinking === undefined) return undefined
  if (reasoningEffort !== undefined && !isOpenAIReasoningEffortSupported(modelId, reasoningEffort)) return undefined
  return {
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  }
}

function isOpenAIStyleEffectiveProvider(provider: ModelProvider | undefined): boolean {
  return (
    provider === ModelProviderEnum.OpenAI ||
    provider === ModelProviderEnum.OpenAIResponses ||
    provider === ModelProviderEnum.Azure
  )
}

type LegacyOpenAICompatibleReasoning = NonNullable<ProviderOptions['openaiCompatible']>['reasoning']

/**
 * Interprets the legacy `openaiCompatible.reasoning` options (written by older
 * versions) as a DeepSeek-style thinking toggle. Shared with the ChatboxAI
 * gateway model so both read paths agree.
 */
export function getLegacyOpenAICompatibleThinkingType(
  reasoning: LegacyOpenAICompatibleReasoning
): 'enabled' | 'disabled' | undefined {
  if (!reasoning) return undefined
  if (reasoning.enabled === false || reasoning.exclude === true) return 'disabled'
  return reasoning.enabled ? 'enabled' : undefined
}

function getEffectiveProvider(
  provider: ModelProvider | undefined,
  model?: ProviderModelInfo | null
): ModelProvider | undefined {
  if (!model?.apiStyle || !usesModelApiStyleForReasoning(provider)) {
    return provider
  }

  if (provider === ModelProviderEnum.OpenRouter) {
    return provider
  }

  if (model.apiStyle === 'anthropic') return ModelProviderEnum.Claude
  if (model.apiStyle === 'google') return ModelProviderEnum.Gemini
  if (model.apiStyle === 'openai-responses') return ModelProviderEnum.OpenAIResponses
  return ModelProviderEnum.OpenAI
}

// All built-in provider ids. Any id outside this set is a user-created custom provider,
// whose reasoning support must be judged by its API style (provider type) + model id.
const BUILTIN_PROVIDER_IDS = new Set<string>(Object.values(ModelProviderEnum))

function isCustomProviderId(provider: ModelProvider | undefined): boolean {
  return !!provider && !BUILTIN_PROVIDER_IDS.has(provider)
}

function usesModelApiStyleForReasoning(provider: ModelProvider | undefined): boolean {
  // ChatboxAI proxies many backend models, and custom providers wrap an upstream API,
  // so for both we resolve the effective provider from the model's API style rather than
  // the provider id itself.
  return (
    provider === ModelProviderEnum.ChatboxAI || provider === ModelProviderEnum.Custom || isCustomProviderId(provider)
  )
}

function isOpenAICompatibleApiStyle(provider: ModelProvider | undefined, model: ProviderModelInfo): boolean {
  // ChatboxAI and custom providers can both expose OpenAI-compatible endpoints; treat a
  // missing/`openai` API style as OpenAI-compatible so model-id based detection (e.g. DeepSeek)
  // works the same way for both.
  return (
    (provider === ModelProviderEnum.ChatboxAI || isCustomProviderId(provider)) &&
    (!model.apiStyle || model.apiStyle === 'openai')
  )
}

export function getReasoningControlCapabilities(
  provider: ModelProvider | undefined,
  model?: ProviderModelInfo | null
): ReasoningControlCapabilities {
  const modelId = model?.modelId
  if (!provider || !modelId) {
    return DEFAULT_CAPABILITIES
  }

  const effectiveProvider = getEffectiveProvider(provider, model)
  const disabledReason = getApiStyleDisabledReason(provider, effectiveProvider, model)
  if (disabledReason) {
    return { supported: false, kind: 'toggle', disabledReason }
  }

  if (effectiveProvider === ModelProviderEnum.Claude && matchesAny(modelId, CLAUDE_ADAPTIVE_EFFORT_MODELS)) {
    return { supported: true, kind: 'anthropic-adaptive-effort' }
  }
  if (effectiveProvider === ModelProviderEnum.Claude && matchesAny(modelId, CLAUDE_EFFORT_MODELS)) {
    return { supported: true, kind: 'anthropic-effort' }
  }
  if (effectiveProvider === ModelProviderEnum.Claude && matchesAny(modelId, CLAUDE_BUDGET_MODELS)) {
    return { supported: true, kind: 'budget' }
  }
  if (effectiveProvider === ModelProviderEnum.Gemini) {
    const mode = getGoogleThinkingMode(modelId)
    if (mode === 'budget') return { supported: true, kind: 'budget' }
    if (mode === 'level') return { supported: true, kind: 'level' }
  }
  if (effectiveProvider === ModelProviderEnum.DeepSeek && isDeepSeekThinkingModel(model)) {
    return {
      supported: true,
      kind: /(?:^|\/)deepseek-v4-(?:flash|pro)(?:[.-]|$)/i.test(modelId) ? 'deepseek-effort' : 'toggle',
    }
  }
  if (model && isOpenAICompatibleApiStyle(provider, model) && isDeepSeekThinkingModel(model)) {
    return {
      supported: true,
      kind: /(?:^|\/)deepseek-v4-(?:flash|pro)(?:[.-]|$)/i.test(modelId) ? 'deepseek-effort' : 'toggle',
    }
  }
  if (isOpenAIStyleEffectiveProvider(effectiveProvider) && isGptEffortModel(modelId)) {
    return { supported: true, kind: 'openai-effort' }
  }
  if (
    (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) &&
    matchesAny(modelId, QWEN_THINKING_MODELS)
  ) {
    return { supported: true, kind: 'budget' }
  }
  if (effectiveProvider === ModelProviderEnum.XAI && matchesAny(modelId, GROK_REASONING_EFFORT_MODELS)) {
    return { supported: true, kind: 'xai-effort' }
  }
  if (
    effectiveProvider === ModelProviderEnum.OpenRouter &&
    (model.reasoning !== undefined || isOpenRouterReasoningModel(model))
  ) {
    return { supported: true, kind: 'openrouter-reasoning' }
  }
  if (
    (provider === ModelProviderEnum.Custom || isCustomProviderId(provider)) &&
    !matchesAny(modelId, GPT_NON_REASONING_CHAT_MODELS) &&
    (!model.apiStyle || model.apiStyle === 'openai' || model.apiStyle === 'openai-responses')
  ) {
    // Unknown relay models remain opt-in: default sends no extra parameter,
    // while Custom lets the user provide the relay's exact effort value.
    return { supported: true, kind: 'custom-effort' }
  }

  return DEFAULT_CAPABILITIES
}

function getApiStyleDisabledReason(
  provider: ModelProvider | undefined,
  effectiveProvider: ModelProvider | undefined,
  model: ProviderModelInfo
): ReasoningControlDisabledReason | undefined {
  if (effectiveProvider === ModelProviderEnum.OpenRouter) {
    return undefined
  }

  const modelId = model.modelId
  if (matchesAny(modelId, [...CLAUDE_ADAPTIVE_EFFORT_MODELS, ...CLAUDE_EFFORT_MODELS, ...CLAUDE_BUDGET_MODELS])) {
    if (effectiveProvider !== ModelProviderEnum.Claude) {
      return 'requires-anthropic-api-style'
    }
  }

  if (getGoogleThinkingMode(modelId) !== 'none') {
    if (effectiveProvider !== ModelProviderEnum.Gemini) {
      return 'requires-google-api-style'
    }
  }

  if (isGptEffortModel(modelId) && !isOpenAIStyleEffectiveProvider(effectiveProvider)) {
    return 'requires-openai-api-style'
  }

  if (
    isDeepSeekReasoningModel(modelId) &&
    effectiveProvider !== ModelProviderEnum.DeepSeek &&
    !isOpenAICompatibleApiStyle(provider, model)
  ) {
    return 'requires-deepseek-api-style'
  }

  if (
    matchesAny(modelId, QWEN_THINKING_MODELS) &&
    effectiveProvider !== ModelProviderEnum.Qwen &&
    effectiveProvider !== ModelProviderEnum.QwenPortal
  ) {
    return 'requires-qwen-api-style'
  }

  if (matchesAny(modelId, GROK_REASONING_EFFORT_MODELS) && effectiveProvider !== ModelProviderEnum.XAI) {
    return 'requires-xai-api-style'
  }

  return undefined
}

export function getReasoningControlLevel(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  providerOptions?: ProviderOptions
): ReasoningControlLevel {
  const level = deriveReasoningControlLevel(provider, model, providerOptions)
  if (level === 'default') return level
  // Stale options written for another model generation must never leave the
  // selector with a value that is not available for the current model.
  const options = getReasoningControlOptions(provider, model)
  if (options.some((option) => option.level === level)) return level
  // A relay may accept a standard-looking value that its identified upstream
  // model does not advertise (for example max on GPT-5.5). Preserve it as an
  // explicit custom value instead of silently presenting it as Default.
  if (
    options.some((option) => option.level === 'custom') &&
    hasUsableCustomReasoningValue(provider, model, providerOptions)
  ) {
    return 'custom'
  }
  return 'default'
}

function deriveReasoningControlLevel(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  providerOptions?: ProviderOptions
): ReasoningControlLevel {
  const capabilities = getReasoningControlCapabilities(provider, model)
  if (!capabilities.supported) return 'default'

  const effectiveProvider = getEffectiveProvider(provider, model)
  if (model && isOpenAICompatibleApiStyle(provider, model) && isDeepSeekThinkingModel(model)) {
    const deepseekThinking =
      provider === ModelProviderEnum.ChatboxAI
        ? providerOptions?.deepseek?.thinking
        : providerOptions?.openaiCompatible?.thinking
    const effort =
      provider === ModelProviderEnum.ChatboxAI
        ? providerOptions?.deepseek?.reasoningEffort
        : providerOptions?.openaiCompatible?.reasoningEffort
    if (deepseekThinking) {
      return deepseekThinking.type === 'enabled' ? normalizeEffortToLevel(effort || 'high') : 'off'
    }
    const legacyType = getLegacyOpenAICompatibleThinkingType(providerOptions?.openaiCompatible?.reasoning)
    if (legacyType === 'enabled') return 'high'
    if (legacyType === 'disabled') return 'off'
    return 'default'
  }
  if (effectiveProvider === ModelProviderEnum.Claude) {
    if (capabilities.kind === 'anthropic-adaptive-effort' || capabilities.kind === 'anthropic-effort') {
      return normalizeEffortToLevel(providerOptions?.claude?.effort)
    }
    const thinking = providerOptions?.claude?.thinking
    if (!thinking) return 'default'
    if (thinking.type !== 'enabled') return 'off'
    const budget = thinking.budgetTokens
    return readBudgetLevel(budget, CLAUDE_BUDGET_BY_LEVEL, {
      2048: 'low',
      5120: 'medium',
      10240: 'high',
    })
  }
  if (capabilities.kind === 'custom-effort') {
    return providerOptions?.openai?.reasoningEffort || providerOptions?.openaiCompatible?.reasoningEffort
      ? 'custom'
      : 'default'
  }
  if (isOpenAIStyleEffectiveProvider(effectiveProvider)) {
    const effort = providerOptions?.openai?.reasoningEffort
    return normalizeEffortToLevel(effort)
  }
  if (effectiveProvider === ModelProviderEnum.XAI) {
    const effort = providerOptions?.openai?.reasoningEffort
    return normalizeEffortToLevel(effort)
  }
  if (effectiveProvider === ModelProviderEnum.OpenRouter) {
    const reasoning = providerOptions?.openrouter?.reasoning
    if (!reasoning) return 'default'
    if (reasoning.enabled === false) return 'off'
    if (reasoning.max_tokens !== undefined) return reasoning.max_tokens > 0 ? 'custom' : 'default'
    return normalizeEffortToLevel(reasoning.effort)
  }
  if (effectiveProvider === ModelProviderEnum.Gemini) {
    const config = providerOptions?.google?.thinkingConfig
    if (!config) return 'default'
    if (config.thinkingLevel) return config.thinkingLevel
    const budget = config.thinkingBudget
    if (budget === undefined || budget <= 0) return 'off'
    return readBudgetLevel(budget, GEMINI_BUDGET_BY_LEVEL, {
      2048: 'low',
      5120: 'medium',
      10240: 'high',
    })
  }
  if (effectiveProvider === ModelProviderEnum.DeepSeek) {
    const thinking = providerOptions?.deepseek?.thinking
    if (!thinking) return 'default'
    return thinking.type === 'enabled'
      ? normalizeEffortToLevel(providerOptions?.deepseek?.reasoningEffort || 'high')
      : 'off'
  }
  if (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) {
    const openaiCompatible = providerOptions?.openaiCompatible
    if (openaiCompatible?.enable_thinking === false) return 'off'
    if (openaiCompatible?.enable_thinking !== true) return 'default'
    const budget = openaiCompatible.thinking_budget
    if (budget === undefined) return 'low'
    return readBudgetLevel(budget, QWEN_THINKING_BUDGET_BY_LEVEL)
  }
  return 'default'
}

function readBudgetLevel(
  budget: number,
  presets: Record<BudgetReasoningLevel, number>,
  legacy: Record<number, BudgetReasoningLevel> = {}
): ReasoningControlLevel {
  const preset = (Object.entries(presets) as Array<[BudgetReasoningLevel, number]>).find(
    ([, value]) => value === budget
  )?.[0]
  return preset || legacy[budget] || 'custom'
}

export function getReasoningCustomValue(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  providerOptions?: ProviderOptions
): string {
  const capabilities = getReasoningControlCapabilities(provider, model)
  const effectiveProvider = getEffectiveProvider(provider, model)

  if (capabilities.kind === 'custom-effort') {
    return providerOptions?.openai?.reasoningEffort || providerOptions?.openaiCompatible?.reasoningEffort || ''
  }
  if (model && isOpenAICompatibleApiStyle(provider, model) && isDeepSeekThinkingModel(model)) {
    return (
      (provider === ModelProviderEnum.ChatboxAI
        ? providerOptions?.deepseek?.reasoningEffort
        : providerOptions?.openaiCompatible?.reasoningEffort) || ''
    )
  }
  if (effectiveProvider === ModelProviderEnum.Claude) {
    if (capabilities.kind === 'budget') {
      return providerOptions?.claude?.thinking?.budgetTokens?.toString() || ''
    }
    return providerOptions?.claude?.effort || ''
  }
  if (isOpenAIStyleEffectiveProvider(effectiveProvider) || effectiveProvider === ModelProviderEnum.XAI) {
    return providerOptions?.openai?.reasoningEffort || ''
  }
  if (effectiveProvider === ModelProviderEnum.OpenRouter) {
    const reasoning = providerOptions?.openrouter?.reasoning
    return reasoning?.max_tokens?.toString() || reasoning?.effort || ''
  }
  if (effectiveProvider === ModelProviderEnum.Gemini) {
    return providerOptions?.google?.thinkingConfig?.thinkingBudget?.toString() || ''
  }
  if (effectiveProvider === ModelProviderEnum.DeepSeek) {
    return providerOptions?.deepseek?.reasoningEffort || ''
  }
  if (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) {
    return providerOptions?.openaiCompatible?.thinking_budget?.toString() || ''
  }
  return ''
}

function hasUsableCustomReasoningValue(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  providerOptions?: ProviderOptions
): boolean {
  const value = getReasoningCustomValue(provider, model, providerOptions).trim()
  if (!value) return false
  if (getReasoningControlCapabilities(provider, model).kind !== 'budget') return true
  const budget = Number(value)
  return Number.isInteger(budget) && budget > 0
}

export function getReasoningControlOptions(
  provider: ModelProvider | undefined,
  model?: ProviderModelInfo | null
): ReasoningControlOption[] {
  const capabilities = getReasoningControlCapabilities(provider, model)
  if (!capabilities.supported) return []

  const offOption: ReasoningControlOption[] = supportsExplicitDisable(
    capabilities.kind,
    getEffectiveProvider(provider, model),
    model?.modelId || '',
    model?.reasoning?.mandatory
  )
    ? [{ level: 'off', label: 'off' }]
    : []

  if (capabilities.kind === 'toggle') {
    return [{ level: 'default', label: 'default' }, ...offOption, { level: 'high', label: 'on' }]
  }

  const presetOptions = getSupportedReasoningLevels(provider, model, capabilities).map(
    (level): ReasoningControlOption => ({ level, label: level })
  )
  const customOption: ReasoningControlOption[] = supportsCustomReasoningValue(provider, model, capabilities)
    ? [{ level: 'custom', label: 'custom' }]
    : []

  return [{ level: 'default', label: 'default' }, ...offOption, ...presetOptions, ...customOption]
}

function getSupportedReasoningLevels(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  capabilities = getReasoningControlCapabilities(provider, model)
): ReasoningPresetLevel[] {
  const modelId = model?.modelId || ''
  switch (capabilities.kind) {
    case 'anthropic-adaptive-effort':
    case 'anthropic-effort':
      return getClaudeReasoningLevels(modelId)
    case 'deepseek-effort':
      return getDeepSeekReasoningLevels(modelId)
    case 'level':
      return getSupportedGoogleThinkingLevels(modelId)
    case 'openai-effort':
      // The bundled OpenAI Chat/Azure transport currently validates efforts only
      // through xhigh. Responses and OpenAI-compatible transports accept arbitrary
      // strings, so they can expose the official GPT-5.6 max level immediately.
      return provider === ModelProviderEnum.OpenAI || provider === ModelProviderEnum.Azure
        ? getOpenAIReasoningLevels(modelId).filter((level) => level !== 'max')
        : getOpenAIReasoningLevels(modelId)
    case 'openrouter-reasoning':
      return (
        normalizeAdvertisedEfforts(model?.reasoning?.supportedEfforts) ||
        (isGptEffortModel(modelId)
          ? getOpenAIReasoningLevels(modelId)
          : matchesAny(modelId, GROK_REASONING_EFFORT_MODELS)
            ? getXAIReasoningLevels(modelId)
            : [...REASONING_PRESET_LEVELS])
      )
    case 'xai-effort':
      return getXAIReasoningLevels(modelId)
    case 'budget':
      return ['low', 'medium', 'high']
    case 'custom-effort':
      return []
    case 'toggle':
      return ['high']
  }
}

function supportsCustomReasoningValue(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  capabilities: ReasoningControlCapabilities
): boolean {
  return (
    capabilities.kind === 'custom-effort' ||
    capabilities.kind === 'budget' ||
    (provider === ModelProviderEnum.OpenRouter && model?.reasoning?.supportsMaxTokens === true) ||
    provider === ModelProviderEnum.Custom ||
    isCustomProviderId(provider)
  )
}

export function getReasoningProviderOptions(
  provider: ModelProvider | undefined,
  model: ProviderModelInfo | null | undefined,
  level: ReasoningControlLevel,
  previous?: ProviderOptions,
  customValue?: string
): ProviderOptions | undefined {
  const capabilities = getReasoningControlCapabilities(provider, model)
  if (!capabilities.supported) return previous

  const effectiveProvider = getEffectiveProvider(provider, model)

  // 'default' means "send no reasoning parameters": drop every reasoning namespace so the
  // provider's server-side default applies. Also the fallback for 'off' on models whose
  // thinking cannot be explicitly disabled.
  if (
    level === 'default' ||
    (level === 'off' &&
      !supportsExplicitDisable(capabilities.kind, effectiveProvider, model?.modelId || '', model?.reasoning?.mandatory))
  ) {
    return stripReasoningProviderOptions(previous)
  }

  const next: ProviderOptions = { ...(previous || {}) }

  if (level === 'off') {
    if (effectiveProvider === ModelProviderEnum.Claude) {
      next.claude = { thinking: { type: 'disabled', budgetTokens: 0 } }
    } else if (isOpenAICompatibleApiStyle(provider, model as ProviderModelInfo) && isDeepSeekThinkingModel(model)) {
      if (provider === ModelProviderEnum.ChatboxAI) {
        next.deepseek = { thinking: { type: 'disabled' } }
      } else {
        next.openaiCompatible = { thinking: { type: 'disabled' } }
      }
    } else if (isOpenAIStyleEffectiveProvider(effectiveProvider)) {
      next.openai = {
        reasoningEffort: getOpenAIReasoningEffort(model?.modelId || '', level),
        forceReasoning: true,
      }
    } else if (effectiveProvider === ModelProviderEnum.XAI) {
      next.openai = { reasoningEffort: 'none', forceReasoning: true }
    } else if (effectiveProvider === ModelProviderEnum.OpenRouter) {
      next.openrouter = { reasoning: { enabled: false, exclude: true } }
    } else if (effectiveProvider === ModelProviderEnum.Gemini) {
      next.google = { thinkingConfig: getGoogleOffThinkingConfig(model?.modelId || '') }
    } else if (effectiveProvider === ModelProviderEnum.DeepSeek) {
      next.deepseek = { thinking: { type: 'disabled' } }
    } else if (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) {
      next.openaiCompatible = { enable_thinking: false }
    }
    return compactProviderOptions(next)
  }

  const effortValue = level === 'custom' ? customValue?.trim() : level
  if (!effortValue) {
    return stripReasoningProviderOptions(previous)
  }

  if (capabilities.kind === 'custom-effort') {
    next.openai = { reasoningEffort: effortValue }
  } else if (effectiveProvider === ModelProviderEnum.Claude) {
    if (capabilities.kind === 'anthropic-adaptive-effort' || capabilities.kind === 'anthropic-effort') {
      next.claude = { effort: effortValue }
    } else {
      const budgetTokens = getReasoningBudget(level, customValue, CLAUDE_BUDGET_BY_LEVEL)
      if (!budgetTokens) return stripReasoningProviderOptions(previous)
      next.claude = { thinking: { type: 'enabled', budgetTokens } }
    }
  } else if (isOpenAICompatibleApiStyle(provider, model as ProviderModelInfo) && isDeepSeekThinkingModel(model)) {
    if (provider === ModelProviderEnum.ChatboxAI) {
      next.deepseek = {
        thinking: { type: 'enabled' },
        ...(capabilities.kind === 'deepseek-effort' ? { reasoningEffort: effortValue } : {}),
      }
    } else {
      next.openaiCompatible = {
        thinking: { type: 'enabled' },
        ...(capabilities.kind === 'deepseek-effort' ? { reasoningEffort: effortValue } : {}),
      }
    }
  } else if (isOpenAIStyleEffectiveProvider(effectiveProvider)) {
    // Keep compatible wire mappings in pickOpenAICompatibleReasoningOptions in sync when
    // adding an OpenAI option here. OpenAI-only SDK flags must not leak to compatible APIs.
    next.openai = {
      reasoningEffort: level === 'custom' ? effortValue : getOpenAIReasoningEffort(model?.modelId || '', level),
      ...(effectiveProvider === ModelProviderEnum.OpenAIResponses
        ? {
            reasoningSummary: 'auto' as const,
            include: ['reasoning.encrypted_content'],
            forceReasoning: true,
          }
        : {}),
    }
  } else if (effectiveProvider === ModelProviderEnum.XAI) {
    next.openai = {
      reasoningEffort: effortValue,
      include: ['reasoning.encrypted_content'],
      forceReasoning: true,
    }
  } else if (effectiveProvider === ModelProviderEnum.OpenRouter) {
    if (level === 'custom' && model?.reasoning?.supportsMaxTokens) {
      const maxTokens = Number(effortValue)
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
        return stripReasoningProviderOptions(previous)
      }
      next.openrouter = {
        reasoning: {
          max_tokens: maxTokens,
          exclude: false,
        },
      }
      return compactProviderOptions(next)
    }
    next.openrouter = {
      reasoning: {
        effort: effortValue,
        exclude: false,
      },
    }
  } else if (effectiveProvider === ModelProviderEnum.Gemini) {
    if (capabilities.kind === 'level') {
      if (!REASONING_PRESET_LEVELS.includes(effortValue as ReasoningPresetLevel)) {
        return stripReasoningProviderOptions(previous)
      }
      next.google = {
        thinkingConfig: { thinkingLevel: effortValue as GoogleThinkingLevel, includeThoughts: true },
      }
    } else {
      const thinkingBudget = getReasoningBudget(level, customValue, GEMINI_BUDGET_BY_LEVEL)
      if (!thinkingBudget) return stripReasoningProviderOptions(previous)
      next.google = { thinkingConfig: { thinkingBudget, includeThoughts: true } }
    }
  } else if (effectiveProvider === ModelProviderEnum.DeepSeek) {
    next.deepseek = {
      thinking: { type: 'enabled' },
      ...(capabilities.kind === 'deepseek-effort' ? { reasoningEffort: effortValue } : {}),
    }
  } else if (effectiveProvider === ModelProviderEnum.Qwen || effectiveProvider === ModelProviderEnum.QwenPortal) {
    const thinkingBudget = getReasoningBudget(level, customValue, QWEN_THINKING_BUDGET_BY_LEVEL)
    if (!thinkingBudget) return stripReasoningProviderOptions(previous)
    next.openaiCompatible = {
      enable_thinking: true,
      thinking_budget: thinkingBudget,
    }
  }

  return compactProviderOptions(next)
}

function getReasoningBudget(
  level: ReasoningControlLevel,
  customValue: string | undefined,
  presets: Record<BudgetReasoningLevel, number>
): number | undefined {
  if (level === 'custom') {
    const parsed = Number(customValue?.trim())
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  if (level === 'low' || level === 'medium' || level === 'high') {
    return presets[level]
  }
  return undefined
}

function isDeepSeekThinkingModel(model: ProviderModelInfo | null | undefined): boolean {
  if (!model?.modelId) return false
  return isDeepSeekReasoningModel(model.modelId)
}

function getGoogleOffThinkingConfig(modelId: string): NonNullable<ProviderOptions['google']>['thinkingConfig'] {
  if (getGoogleThinkingMode(modelId) === 'level') {
    const supportedLevels = getSupportedGoogleThinkingLevels(modelId)
    return {
      thinkingLevel: supportedLevels.includes('minimal') ? 'minimal' : 'low',
      includeThoughts: false,
    }
  }

  return { thinkingBudget: 0, includeThoughts: false }
}

function isOpenRouterReasoningModel(model: ProviderModelInfo | null | undefined): boolean {
  if (!model?.modelId) return false
  if (isDeepSeekReasoningModel(model.modelId)) return true
  if (isGptEffortModel(model.modelId)) return true
  return matchesAny(model.modelId, [
    ...CLAUDE_ADAPTIVE_EFFORT_MODELS,
    ...CLAUDE_EFFORT_MODELS,
    ...CLAUDE_BUDGET_MODELS,
    ...QWEN_THINKING_MODELS,
    ...GROK_REASONING_EFFORT_MODELS,
    // o1-preview/o1-mini reject the direct reasoning_effort param, but OpenRouter maps
    // its own reasoning options per model, so they keep reasoning controls there.
    ...OPENAI_NO_EFFORT_PARAM_MODELS,
  ])
}

export function getOpenAIReasoningEffort(
  modelId: string,
  level: 'off' | ReasoningPresetLevel
): NonNullable<ProviderOptions['openai']>['reasoningEffort'] {
  if (level === 'off') {
    return matchesAny(modelId, OPENAI_NONE_EFFORT_MODELS) ? 'none' : 'minimal'
  }
  return level
}

function normalizeEffortToLevel(effort: string | undefined): ReasoningControlLevel {
  if (!effort) return 'default'
  if (effort === 'none') return 'off'
  if (REASONING_PRESET_LEVELS.includes(effort as ReasoningPresetLevel)) {
    return effort as ReasoningPresetLevel
  }
  return 'custom'
}

function compactProviderOptions(options: ProviderOptions): ProviderOptions | undefined {
  const next: ProviderOptions = { ...options }
  if (!next.claude) delete next.claude
  if (!next.openai) delete next.openai
  if (!next.google) delete next.google
  if (!next.deepseek) delete next.deepseek
  if (!next.openaiCompatible) delete next.openaiCompatible
  if (!next.openrouter) delete next.openrouter
  return Object.keys(next).length > 0 ? next : undefined
}

// Provider option namespaces that exclusively carry reasoning/thinking configuration.
// Keep this in sync with ProviderOptionsSchema in shared/types/settings.ts.
const REASONING_PROVIDER_OPTION_KEYS = [
  'claude',
  'openai',
  'google',
  'deepseek',
  'openaiCompatible',
  'openrouter',
] as const satisfies readonly (keyof ProviderOptions)[]

/**
 * Removes reasoning/thinking provider options so they are never sent to a model
 * that does not support reasoning control. This guards against stale options
 * persisted on a session (e.g. set on a reasoning-capable model, then carried
 * over after switching to a model without reasoning support). It also implements
 * the 'default' reasoning level (send no reasoning parameters) and the fallback
 * when 'off' is requested for a model whose thinking cannot be force-disabled.
 */
export function stripReasoningProviderOptions(
  providerOptions: ProviderOptions | undefined
): ProviderOptions | undefined {
  if (!providerOptions) return providerOptions
  const next: ProviderOptions = { ...providerOptions }
  let changed = false
  for (const key of REASONING_PROVIDER_OPTION_KEYS) {
    if (next[key] !== undefined) {
      delete next[key]
      changed = true
    }
  }
  if (!changed) return providerOptions
  return Object.keys(next).length > 0 ? next : undefined
}
