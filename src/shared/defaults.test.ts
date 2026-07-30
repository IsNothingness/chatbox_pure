import { describe, expect, it } from 'vitest'
import { chatSessionSettings, getDefaultPrompt, newConfigs, pictureSessionSettings, settings } from './defaults'
import { ModelProviderEnum, type SessionSettings, type Settings, Theme } from './types'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('defaults', () => {
  it('settings() returns expected default values', () => {
    const result: Settings = settings()

    expect(result.theme).toBe(Theme.System)
    expect(result.language).toBe('en')
    expect(result.fontSize).toBe(14)
    expect(result.spellCheck).toBe(true)
    expect(result.showWordCount).toBe(false)
    expect(result.showTokenCount).toBe(false)
    expect(result.showTokenUsed).toBe(true)
    expect(result.messageLayout).toBe('bubble')
    expect(result.conversationListMenu).toEqual({
      pin: true,
      edit: true,
      duplicate: true,
      reorder: true,
      archive: true,
      delete: true,
    })
  })

  it('settings() disables reporting and tracking by default', () => {
    expect(settings().allowReportingAndTracking).toBe(false)
  })

  it('settings() returns enableMarkdownRendering as true', () => {
    expect(settings().enableMarkdownRendering).toBe(true)
  })

  it('settings() returns shortcuts object with expected keys', () => {
    const result = settings().shortcuts

    expect(Object.keys(result).sort()).toEqual(
      [
        'quickToggle',
        'inputBoxFocus',
        'inputBoxWebBrowsingMode',
        'newChat',
        'newPictureChat',
        'sessionListNavNext',
        'sessionListNavPrev',
        'sessionListNavTargetIndex',
        'messageListRefreshContext',
        'dialogOpenSearch',
        'inputBoxSendMessage',
        'inputBoxSendMessageWithoutResponse',
        'optionNavUp',
        'optionNavDown',
        'optionSelect',
      ].sort()
    )
    expect(result.messageListRefreshContext).toBe('mod+shift+n')
    expect(result.newPictureChat).toBe('')
  })

  it('newConfigs() returns object with uuid string', () => {
    const result = newConfigs()

    expect(typeof result.uuid).toBe('string')
    expect(result.uuid).toMatch(UUID_REGEX)
  })

  it('getDefaultPrompt() returns expected string', () => {
    expect(getDefaultPrompt()).toBe('You are a helpful assistant.')
  })

  it('chatSessionSettings() returns provider and modelId', () => {
    const result: SessionSettings = chatSessionSettings()

    expect(result.provider).toBe(ModelProviderEnum.OpenAI)
    expect(result.modelId).toBe('gpt-4o')
  })

  it('pictureSessionSettings() returns provider, modelId, dalleStyle, imageGenerateNum', () => {
    const result: SessionSettings = pictureSessionSettings()

    expect(result.provider).toBe(ModelProviderEnum.OpenAI)
    expect(result.modelId).toBe('dall-e-3')
    expect(result.dalleStyle).toBe('vivid')
    expect(result.imageGenerateNum).toBe(1)
  })
})
