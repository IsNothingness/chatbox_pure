import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handleMobileRequest: vi.fn(async () => new Response('{}')),
}))

vi.mock('@/platform', () => ({
  default: {
    type: 'mobile',
    getVersion: vi.fn(async () => 'test'),
  },
}))

vi.mock('./mobile-request', () => ({
  handleMobileRequest: mocks.handleMobileRequest,
}))

import { apiRequest } from './request'

describe('mobile request routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('uses the native adapter even when provider proxy routing is disabled', async () => {
    await apiRequest.post(
      'https://api.deepseek.com/chat/completions',
      { Authorization: 'Bearer test' },
      JSON.stringify({ stream: true }),
      { retry: 0, useProxy: false }
    )

    expect(mocks.handleMobileRequest).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      'POST',
      expect.any(Headers),
      JSON.stringify({ stream: true }),
      undefined
    )
  })
})
