import { describe, expect, test } from 'vitest'
import { reportError } from './sentry'

describe('reportError', () => {
  test('keeps handled errors local in Pure builds', () => {
    expect(() =>
      reportError(new Error('boom'), {
        domain: 'session',
        operation: 'generation',
        priority: 'high',
      })
    ).not.toThrow()
  })
})
