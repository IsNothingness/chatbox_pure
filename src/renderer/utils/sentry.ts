import type { SentryErrorPriority } from '@shared/utils/sentry_policy'

export interface ReportErrorContext {
  domain: string
  extras?: Record<string, unknown>
  handled?: boolean
  operation: string
  priority?: SentryErrorPriority
  tags?: Record<string, string | number | boolean>
}

/** Pure builds keep error details in local application logs only. */
export function reportError(_error: unknown, _context: ReportErrorContext): void {}
