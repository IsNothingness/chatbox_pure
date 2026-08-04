type GenerationStop = () => void

const activeStopsBySessionId = new Map<string, GenerationStop>()

export function registerActiveGenerationStop(sessionId: string, stop: GenerationStop): () => void {
  activeStopsBySessionId.set(sessionId, stop)
  return () => {
    if (activeStopsBySessionId.get(sessionId) === stop) {
      activeStopsBySessionId.delete(sessionId)
    }
  }
}

export function stopActiveGeneration(sessionId: string): boolean {
  const stop = activeStopsBySessionId.get(sessionId)
  if (!stop) return false
  stop()
  return true
}
