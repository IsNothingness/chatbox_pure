/** Pure builds do not transmit product analytics. */
export function trackEvent(_event: string, _props: Record<string, unknown> = {}): void {}
