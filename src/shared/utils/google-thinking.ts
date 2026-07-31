export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'
export type GoogleThinkingMode = 'budget' | 'level' | 'none'

export interface GoogleThinkingConfig {
  thinkingBudget?: number
  thinkingLevel?: GoogleThinkingLevel
  includeThoughts?: boolean
}

const GOOGLE_THINKING_LEVELS_BY_MODEL: Array<[RegExp, GoogleThinkingLevel[]]> = [
  // Exact families from the official Gemini thinking table. Keep the
  // narrower entries first because several families intentionally expose
  // only a subset of the common four levels.
  [/^gemini-3\.1-flash-lite-image(?:-|$)/i, ['minimal', 'high']],
  [/^gemini-3(?:\.0)?-pro-preview(?:-|$)/i, ['low', 'high']],
  [/^gemini-3\.1-pro-preview(?:-|$)/i, ['low', 'medium', 'high']],
  [/^gemini-3\.6-flash(?:-|$)/i, ['minimal', 'low', 'medium', 'high']],
  [/^gemini-3\.5-flash-lite(?:-|$)/i, ['minimal', 'low', 'medium', 'high']],
  [/^gemini-3\.5-flash(?:-|$)/i, ['minimal', 'low', 'medium', 'high']],
  [/^gemini-3(?:\.0)?-flash-preview(?:-|$)/i, ['minimal', 'low', 'medium', 'high']],
]

const GOOGLE_DEFAULT_THINKING_LEVEL_BY_MODEL: Array<[RegExp, GoogleThinkingLevel]> = [
  [/^gemini-3\.6-flash(?:-|$)/i, 'medium'],
  [/^gemini-3\.5-flash-lite(?:-|$)/i, 'minimal'],
  [/^gemini-3\.5-flash(?:-|$)/i, 'medium'],
  [/^gemini-3\.1-flash-lite-image(?:-|$)/i, 'minimal'],
  [/^gemini-3\.1-pro-preview(?:-|$)/i, 'high'],
  [/^gemini-3(?:\.0)?-flash-preview(?:-|$)/i, 'high'],
  [/^gemini-3(?:\.0)?-pro-preview(?:-|$)/i, 'high'],
]

export function getGoogleThinkingMode(modelId: string): GoogleThinkingMode {
  const id = modelId.toLowerCase().split('/').at(-1) || modelId.toLowerCase()
  // Gemini 3.1 Flash-Lite Image is the documented exception: it supports
  // minimal/high. Other image generation models reject thinkingConfig.
  if (id.includes('-image') && !id.startsWith('gemini-3.1-flash-lite-image')) {
    return 'none'
  }

  if (id.startsWith('gemini-3')) {
    return 'level'
  }

  if (id.startsWith('gemini-2.5')) {
    return 'budget'
  }

  return 'none'
}

// Gemini 3 models cannot turn thinking off. Gemini 2.5 Pro also enforces a
// positive minimum budget, while the 2.5 Flash families accept budget 0.
const GOOGLE_NO_DISABLE_MODELS = [/(?:^|\/)gemini-3(?:[.-]|$)/i, /(?:^|\/)gemini-2\.5[\w.-]*-pro/i]

export function canDisableGoogleThinking(modelId: string): boolean {
  const normalizedModelId = modelId.split('/').at(-1) || modelId
  return !GOOGLE_NO_DISABLE_MODELS.some((pattern) => pattern.test(normalizedModelId))
}

export function getSupportedGoogleThinkingLevels(modelId: string): GoogleThinkingLevel[] {
  if (getGoogleThinkingMode(modelId) !== 'level') {
    return []
  }

  const normalizedModelId = modelId.split('/').at(-1) || modelId
  const match = GOOGLE_THINKING_LEVELS_BY_MODEL.find(([pattern]) => pattern.test(normalizedModelId))

  return match?.[1] || []
}

export function getDefaultGoogleThinkingLevel(modelId: string): GoogleThinkingLevel | undefined {
  const supportedLevels = getSupportedGoogleThinkingLevels(modelId)
  if (supportedLevels.length === 0) return undefined

  const normalizedModelId = modelId.split('/').at(-1) || modelId
  const documentedDefault = GOOGLE_DEFAULT_THINKING_LEVEL_BY_MODEL.find(([pattern]) =>
    pattern.test(normalizedModelId)
  )?.[1]

  return documentedDefault && supportedLevels.includes(documentedDefault) ? documentedDefault : supportedLevels.at(-1)
}

export function normalizeGoogleThinkingConfig(
  modelId: string,
  thinkingConfig?: GoogleThinkingConfig
): GoogleThinkingConfig | undefined {
  const mode = getGoogleThinkingMode(modelId)

  if (!thinkingConfig) {
    // "Default" is represented by omission. Do not materialize the model's
    // documented default into persisted/request options.
    return undefined
  }

  if (mode === 'budget') {
    return {
      ...(thinkingConfig.thinkingBudget !== undefined ? { thinkingBudget: thinkingConfig.thinkingBudget } : {}),
      ...(thinkingConfig.includeThoughts !== undefined ? { includeThoughts: thinkingConfig.includeThoughts } : {}),
    }
  }

  if (mode === 'level') {
    const supportedLevels = getSupportedGoogleThinkingLevels(modelId)
    const thinkingLevel = thinkingConfig.thinkingLevel

    // Fix: strip thinkingLevel for Gemini 3 models not in the supported list (e.g. image models),
    // so stale levels from a previous model selection are not sent to the API.
    if (supportedLevels.length === 0) {
      return thinkingConfig.includeThoughts !== undefined
        ? { includeThoughts: thinkingConfig.includeThoughts }
        : undefined
    }

    // Use the saved level if valid, otherwise send the model's documented default.
    const effectiveLevel =
      thinkingLevel && supportedLevels.includes(thinkingLevel) ? thinkingLevel : getDefaultGoogleThinkingLevel(modelId)

    return {
      ...(effectiveLevel ? { thinkingLevel: effectiveLevel } : {}),
      ...(thinkingConfig.includeThoughts !== undefined ? { includeThoughts: thinkingConfig.includeThoughts } : {}),
    }
  }

  // Mode 'none': the model does not support thinking, never send a thinkingConfig.
  return undefined
}
