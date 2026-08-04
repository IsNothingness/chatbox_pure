export interface NativeGenerationRequestContext {
  clientRequestId: string
  sessionId: string
  messageId: string
  resumeStreamId?: string
}

interface NativeGenerationContextState extends NativeGenerationRequestContext {
  resumeConsumed: boolean
  attachedStreamIds: Set<string>
  gracefulStopRequested: boolean
}

const contexts = new WeakMap<AbortSignal, NativeGenerationContextState>()

export function registerNativeGenerationContext(signal: AbortSignal, context: NativeGenerationRequestContext): void {
  contexts.set(signal, {
    ...context,
    resumeConsumed: false,
    attachedStreamIds: new Set(),
    gracefulStopRequested: false,
  })
}

/**
 * Returns metadata for a native streaming request. A recovered stream may only be consumed by
 * the first streaming HTTP request in the reconstructed model pipeline; later tool/model steps
 * must start their own connections.
 */
export function consumeNativeGenerationContext(
  signal: AbortSignal | undefined
): NativeGenerationRequestContext | undefined {
  if (!signal) return undefined
  const context = contexts.get(signal)
  if (!context) return undefined

  const resumeStreamId = context.resumeConsumed ? undefined : context.resumeStreamId
  if (resumeStreamId) {
    context.resumeConsumed = true
  }
  return {
    clientRequestId: context.clientRequestId,
    sessionId: context.sessionId,
    messageId: context.messageId,
    resumeStreamId,
  }
}

export function recordAttachedNativeStream(signal: AbortSignal | undefined, streamId: string): void {
  if (!signal) return
  contexts.get(signal)?.attachedStreamIds.add(streamId)
}

/**
 * Marks an attached native response for a two-phase stop. The caller stops the
 * upstream connection, while the renderer keeps parsing every byte already buffered.
 */
export function requestNativeGenerationStop(signal: AbortSignal): string[] {
  const context = contexts.get(signal)
  if (!context || context.attachedStreamIds.size === 0) return []
  context.gracefulStopRequested = true
  return [...context.attachedStreamIds]
}

export function isNativeGenerationStopRequested(signal: AbortSignal): boolean {
  return contexts.get(signal)?.gracefulStopRequested === true
}

export function releaseNativeGenerationContext(signal: AbortSignal): string[] {
  const context = contexts.get(signal)
  contexts.delete(signal)
  return context ? [...context.attachedStreamIds] : []
}
