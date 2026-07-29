import type { SentryAdapter, SentryScope } from '../../shared/utils/sentry_adapter'

const localOnlyScope: SentryScope = {
  setTag: () => undefined,
  setExtra: () => undefined,
}

/**
 * Pure builds keep failures in local logs and never upload crash reports.
 * The adapter remains so model and storage code can keep a platform-neutral API.
 */
export class MainSentryAdapter implements SentryAdapter {
  captureException(_error: unknown): void {}

  withScope(callback: (scope: SentryScope) => void): void {
    callback(localOnlyScope)
  }
}

export const sentry = new MainSentryAdapter()

export function flushSentry(_timeout: number): Promise<boolean> {
  return Promise.resolve(true)
}
