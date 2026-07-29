import { describe, expect, test } from 'vitest'
import { trackEvent } from './track'

describe('trackEvent', () => {
  test('never transmits product analytics in Pure builds', () => {
    expect(trackEvent('generate', { provider: 'custom' })).toBeUndefined()
  })
})
