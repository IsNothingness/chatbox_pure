import {
  AIProviderNoImplementedPaintError,
  ApiError,
  BaseError,
  ChatboxAIAPIError,
  NetworkError,
  OCRError,
} from '@shared/models/errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureExceptionMock = vi.fn()
const setTagMock = vi.fn()

vi.mock('@sentry/react', () => ({
  withScope: (callback: (scope: { setTag: (key: string, value: string) => void }) => void) =>
    callback({ setTag: setTagMock }),
  captureException: (error: unknown) => captureExceptionMock(error),
}))

vi.mock('@/utils/track', () => ({
  trackEvent: vi.fn(),
}))

import { trackEvent } from '@/utils/track'
import {
  bucketCount,
  captureAgentModeException,
  isExpectedGenerationError,
  toBooleanString,
  trackAgentModeSuggested,
} from './agent-mode'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toBooleanString', () => {
  it('maps booleans to string literals', () => {
    expect(toBooleanString(true)).toBe('true')
    expect(toBooleanString(false)).toBe('false')
  })
})

describe('bucketCount', () => {
  it('buckets counts at the 0/1/2+ boundaries', () => {
    expect(bucketCount(-1)).toBe('0')
    expect(bucketCount(0)).toBe('0')
    expect(bucketCount(1)).toBe('1')
    expect(bucketCount(2)).toBe('2_plus')
    expect(bucketCount(100)).toBe('2_plus')
  })
})

describe('trackAgentModeSuggested', () => {
  it('sends bucketed props only', () => {
    trackAgentModeSuggested({ hasFiles: true, fileCount: 3 })
    expect(trackEvent).toHaveBeenCalledWith('agent_mode_suggested', {
      has_files: 'true',
      file_count: '2_plus',
    })
  })
})

describe('isExpectedGenerationError', () => {
  it('treats provider/network errors as expected', () => {
    expect(isExpectedGenerationError(new ApiError('rate limited'))).toBe(true)
    expect(isExpectedGenerationError(new NetworkError('offline', 'https://example.com'))).toBe(true)
    expect(isExpectedGenerationError(ChatboxAIAPIError.fromCodeName('quota', 'token_quota_exhausted'))).toBe(true)
    expect(isExpectedGenerationError(new AIProviderNoImplementedPaintError('openai'))).toBe(true)
    expect(isExpectedGenerationError(new OCRError('builtin', new BaseError('bad image')))).toBe(true)
  })

  it('treats other errors as unexpected', () => {
    expect(isExpectedGenerationError(new Error('boom'))).toBe(false)
    expect(isExpectedGenerationError(new OCRError('builtin', new Error('bad image')))).toBe(false)
    expect(isExpectedGenerationError('string error')).toBe(false)
  })
})

describe('captureAgentModeException', () => {
  it('never uploads handled errors in Pure builds', () => {
    captureAgentModeException(new Error('boom'), { operation: 'generation' })
    expect(captureExceptionMock).not.toHaveBeenCalled()
    expect(setTagMock).not.toHaveBeenCalled()
  })
})
