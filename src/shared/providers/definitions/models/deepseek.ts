import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import AbstractAISDKModel, { type CallSettings } from '../../../models/abstract-ai-sdk'
import { ApiError } from '../../../models/errors'
import type { CallChatCompletionOptions } from '../../../models/types'
import { isDeepSeekReasoningModel, isDeepSeekWeakToolUse } from '../../../models/utils/deepseek'
import type { ProviderModelInfo, ToolUseScope } from '../../../types'
import type { ModelDependencies } from '../../../types/adapters'

interface Options {
  apiKey: string
  model: ProviderModelInfo
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  stream?: boolean
}

export default class DeepSeek extends AbstractAISDKModel {
  public name = 'DeepSeek'

  constructor(
    public options: Options,
    dependencies: ModelDependencies
  ) {
    super(options, dependencies)
  }

  protected getProvider() {
    return createOpenAICompatible({
      name: 'deepseek',
      apiKey: this.options.apiKey,
      baseURL: 'https://api.deepseek.com',
      fetch: this.getPlatformFetch(),
    })
  }

  protected getChatModel(_options: CallChatCompletionOptions): LanguageModelV3 {
    const provider = this.getProvider()
    return provider.languageModel(this.options.model.modelId)
  }

  protected getCallSettings(options: CallChatCompletionOptions): CallSettings {
    const thinkingType = options.providerOptions?.deepseek?.thinking?.type
    const reasoningEffort = options.providerOptions?.deepseek?.reasoningEffort
    const isThinkingMode = this.isSupportReasoning() && thinkingType !== 'disabled'
    const settings: CallSettings = {
      maxOutputTokens: this.options.maxOutputTokens,
    }

    // DeepSeek thinking mode does not support temperature or topP.
    if (!isThinkingMode) {
      settings.temperature = this.options.temperature
      settings.topP = this.options.topP
    }

    if (this.isSupportReasoning() && (thinkingType || reasoningEffort)) {
      settings.providerOptions = {
        deepseek: {
          ...(thinkingType ? { thinking: { type: thinkingType } } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      }
    }

    return settings
  }

  isSupportToolUse(scope?: ToolUseScope) {
    if (isDeepSeekWeakToolUse(this.options.model.modelId, scope)) return false
    return super.isSupportToolUse()
  }

  isSupportReasoning() {
    return isDeepSeekReasoningModel(this.options.model.modelId)
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const res = await this.dependencies.request.apiRequest({
      url: 'https://api.deepseek.com/models',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
      },
    })
    const json = await res.json()
    if (!json.data) {
      throw new ApiError(JSON.stringify(json))
    }
    return json.data
      .map((m: { id: string; owned_by?: string }) => ({
        modelId: m.id,
        type: 'chat' as const,
      }))
      .sort((a: ProviderModelInfo, b: ProviderModelInfo) => a.modelId.localeCompare(b.modelId))
  }
}
