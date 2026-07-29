/**
 * Pure starts with an empty conversation list.
 *
 * Keep this migration hook so older storage migrations can call it without
 * creating the upstream example conversations.
 */
export function initData(): Promise<void> {
  return Promise.resolve()
}
