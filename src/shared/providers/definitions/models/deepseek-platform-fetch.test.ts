import type { ModelDependencies } from '@shared/types/adapters'
import type { SentryScope } from '@shared/utils/sentry_adapter'
import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  providerConfig: undefined as { fetch?: typeof globalThis.fetch } | undefined,
  createProvider: vi.fn((config: { fetch?: typeof globalThis.fetch }) => {
    mocks.providerConfig = config
    return { languageModel: vi.fn() }
  }),
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createProvider,
}))

import DeepSeek from './deepseek'

class TestDeepSeek extends DeepSeek {
  public exposeProvider() {
    return this.getProvider()
  }
}

function createDependencies(): ModelDependencies {
  return {
    request: {
      apiRequest: vi.fn(async () => new Response('{}')),
      fetchWithOptions: vi.fn(),
    },
    storage: {
      saveImage: vi.fn(),
      getImage: vi.fn(),
    },
    sentry: {
      captureException: vi.fn(),
      withScope: vi.fn((callback: (scope: SentryScope) => void) =>
        callback({
          setTag: vi.fn(),
          setExtra: vi.fn(),
        })
      ),
    },
    getRemoteConfig: vi.fn(),
    platformType: 'mobile',
  }
}

describe('DeepSeek platform transport', () => {
  test('injects the platform request adapter into the official provider', async () => {
    const dependencies = createDependencies()
    const model = new TestDeepSeek(
      {
        apiKey: 'test-key',
        model: {
          modelId: 'deepseek-chat',
          type: 'chat',
        },
      },
      dependencies
    )

    model.exposeProvider()
    await mocks.providerConfig?.fetch?.('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
    })

    expect(dependencies.request.apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.deepseek.com/chat/completions',
        method: 'POST',
        retry: 0,
      })
    )
  })
})
