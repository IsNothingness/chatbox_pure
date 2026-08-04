import type { Message } from '@shared/types'

interface GenerationRuntime {
  sessionId: string
  message: Message
  startedAt: number
}

const runtimes = new Map<string, GenerationRuntime>()

function runtimeKey(sessionId: string, messageId: string) {
  return `${sessionId}\u0000${messageId}`
}

export function startGenerationRuntime(sessionId: string, message: Message): void {
  runtimes.set(runtimeKey(sessionId, message.id), {
    sessionId,
    message,
    startedAt: Date.now(),
  })
}

export function updateGenerationRuntime(sessionId: string, message: Message): Message {
  const key = runtimeKey(sessionId, message.id)
  const runtime = runtimes.get(key)
  if (runtime) {
    runtime.message = message
  } else {
    startGenerationRuntime(sessionId, message)
  }
  return message
}

export function getGenerationRuntimeMessage(sessionId: string, messageId: string): Message | undefined {
  return runtimes.get(runtimeKey(sessionId, messageId))?.message
}

export function getGenerationRuntimeDuration(sessionId: string, messageId: string): number {
  const runtime = runtimes.get(runtimeKey(sessionId, messageId))
  return runtime ? Math.max(0, Date.now() - runtime.startedAt) : 0
}

export async function commitGenerationRuntime(
  sessionId: string,
  messageId: string,
  persist: (message: Message) => Promise<void>
): Promise<Message> {
  const key = runtimeKey(sessionId, messageId)
  const runtime = runtimes.get(key)
  if (!runtime) {
    throw new Error('Generation runtime is unavailable during final commit')
  }
  const snapshot = runtime.message
  await persist(snapshot)
  // SQL is the new truth only after persistence succeeds. A failed write leaves
  // the full runtime snapshot available for a retry or warm recovery.
  if (runtimes.get(key) === runtime) {
    runtimes.delete(key)
  }
  return snapshot
}

export function releaseGenerationRuntime(sessionId: string, messageId: string): void {
  runtimes.delete(runtimeKey(sessionId, messageId))
}
