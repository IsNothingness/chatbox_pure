/** Pure builds do not transmit product analytics. */
export function trackingEvent(_name: string, _params: { [key: string]: string } = {}): void {}
