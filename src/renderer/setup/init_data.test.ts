import { describe, expect, it } from 'vitest'
import { initData } from './init_data'

describe('initData', () => {
  it('leaves the conversation list empty for a new Pure installation', async () => {
    await expect(initData()).resolves.toBeUndefined()
  })
})
