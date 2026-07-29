import type { SentryAdapter, SentryScope } from '../../shared/utils/sentry_adapter'

const localOnlyScope: SentryScope = {
  setTag: () => undefined,
  setExtra: () => undefined,
}

/** Pure builds do not upload renderer errors. */
export class RendererSentryAdapter implements SentryAdapter {
  captureException(_error: unknown): void {}

  withScope(callback: (scope: SentryScope) => void): void {
    callback(localOnlyScope)
  }
}
