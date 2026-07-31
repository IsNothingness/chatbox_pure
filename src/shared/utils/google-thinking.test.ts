import { describe, expect, it } from 'vitest'
import {
  getDefaultGoogleThinkingLevel,
  getGoogleThinkingMode,
  getSupportedGoogleThinkingLevels,
  normalizeGoogleThinkingConfig,
} from './google-thinking'

describe('google-thinking utils', () => {
  it('detects the correct thinking mode for Gemini model families', () => {
    expect(getGoogleThinkingMode('gemini-2.5-flash')).toBe('budget')
    expect(getGoogleThinkingMode('gemini-3-pro-preview')).toBe('level')
    expect(getGoogleThinkingMode('gemini-3.5-flash')).toBe('level')
    expect(getGoogleThinkingMode('gemini-2.0-flash')).toBe('none')
  })

  it('treats image generation models as non-thinking', () => {
    expect(getGoogleThinkingMode('gemini-2.5-flash-image')).toBe('none')
    expect(getGoogleThinkingMode('gemini-2.5-flash-image-preview')).toBe('none')
    expect(getGoogleThinkingMode('gemini-3-pro-image-preview')).toBe('none')
    expect(getGoogleThinkingMode('gemini-3.1-flash-image-preview')).toBe('none')
  })

  it('returns the documented thinking levels for supported Gemini 3 models', () => {
    // The original Gemini 3 Pro preview only accepts low/high; 3.1 Pro adds medium.
    expect(getSupportedGoogleThinkingLevels('gemini-3-pro-preview')).toEqual(['low', 'high'])
    expect(getSupportedGoogleThinkingLevels('gemini-3.1-pro-preview')).toEqual(['low', 'medium', 'high'])
    // Flash models: minimal/low/medium/high
    expect(getSupportedGoogleThinkingLevels('gemini-3-flash-preview')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(getSupportedGoogleThinkingLevels('gemini-3.5-flash')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(getSupportedGoogleThinkingLevels('gemini-3.1-flash-lite-preview')).toEqual([])
    expect(getSupportedGoogleThinkingLevels('gemini-3.1-flash-lite-image-preview')).toEqual(['minimal', 'high'])
    // Image models: not in the supported list
    expect(getSupportedGoogleThinkingLevels('gemini-3.1-flash-image-preview')).toEqual([])
    expect(getSupportedGoogleThinkingLevels('gemini-3-pro-image-preview')).toEqual([])
  })

  it('uses the documented default Gemini thinking level for each model family', () => {
    expect(getDefaultGoogleThinkingLevel('gemini-3-pro-preview')).toBe('high')
    expect(getDefaultGoogleThinkingLevel('gemini-3-flash-preview')).toBe('high')
    expect(getDefaultGoogleThinkingLevel('gemini-3.6-flash')).toBe('medium')
    expect(getDefaultGoogleThinkingLevel('gemini-3.5-flash')).toBe('medium')
    expect(getDefaultGoogleThinkingLevel('gemini-3.5-flash-lite')).toBe('minimal')
    expect(getDefaultGoogleThinkingLevel('gemini-3.1-flash-lite-image-preview')).toBe('minimal')
    expect(getDefaultGoogleThinkingLevel('gemini-3.1-flash-image-preview')).toBeUndefined()
  })

  it('normalizes budget config for Gemini 2.5 models', () => {
    const config = normalizeGoogleThinkingConfig('gemini-2.5-flash', {
      thinkingBudget: 5000,
      thinkingLevel: 'high',
      includeThoughts: true,
    })
    expect(config).toEqual({ thinkingBudget: 5000, includeThoughts: true })
    expect(config).not.toHaveProperty('thinkingLevel')
  })

  it('normalizes level config for Gemini 3 models', () => {
    const config = normalizeGoogleThinkingConfig('gemini-3-flash-preview', {
      thinkingBudget: 5000,
      thinkingLevel: 'medium',
      includeThoughts: true,
    })
    expect(config).toEqual({ thinkingLevel: 'medium', includeThoughts: true })
    expect(config).not.toHaveProperty('thinkingBudget')
  })

  it('strips the whole config for Gemini image variants', () => {
    expect(
      normalizeGoogleThinkingConfig('gemini-3.1-flash-image-preview', {
        thinkingLevel: 'high',
        includeThoughts: true,
      })
    ).toBeUndefined()
    expect(
      normalizeGoogleThinkingConfig('gemini-2.5-flash-image', {
        thinkingBudget: 24576,
        includeThoughts: true,
      })
    ).toBeUndefined()
    expect(
      normalizeGoogleThinkingConfig('gemini-2.5-flash-image', {
        thinkingBudget: 0,
        includeThoughts: false,
      })
    ).toBeUndefined()
  })

  it('falls back to default level when saved level is invalid', () => {
    const config = normalizeGoogleThinkingConfig('gemini-3-pro-preview', {
      thinkingLevel: 'minimal',
      includeThoughts: true,
    })
    expect(config).toEqual({ thinkingLevel: 'high', includeThoughts: true })
  })

  it('fills in default level when no thinkingLevel is set', () => {
    const config = normalizeGoogleThinkingConfig('gemini-3.6-flash', {
      includeThoughts: true,
    })
    expect(config).toEqual({ thinkingLevel: 'medium', includeThoughts: true })
  })

  it('keeps the provider default implicit when thinkingConfig is undefined', () => {
    const config = normalizeGoogleThinkingConfig('gemini-3-flash-preview', undefined)
    expect(config).toBeUndefined()
  })

  it('returns undefined when thinkingConfig is undefined for non-level models', () => {
    expect(normalizeGoogleThinkingConfig('gemini-2.5-flash', undefined)).toBeUndefined()
    expect(normalizeGoogleThinkingConfig('gemini-2.0-flash', undefined)).toBeUndefined()
  })

  it('strips config for non-thinking models', () => {
    const config = normalizeGoogleThinkingConfig('gemini-2.0-flash', {
      thinkingBudget: 1024,
      includeThoughts: true,
    })
    expect(config).toBeUndefined()
  })
})
