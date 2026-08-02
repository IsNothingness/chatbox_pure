import { acknowledgeNativeStreams, cancelNativeStream, listNativeStreamTasks } from '@/native/stream-http'
import * as chatStore from '@/stores/chatStore'
import { findMessageLocation } from '@/stores/session/forks'
import { resumeNativeBackgroundGeneration } from '@/stores/session/orchestration'
import { CHATBOX_BUILD_PLATFORM } from '@/variables'

const recoveringStreamIds = new Set<string>()

/**
 * Reconstructs the JavaScript model pipeline around a still-running native response stream.
 * The native side replays the original buffered SSE data; this function never submits a
 * replacement model request for the recovered stream.
 */
export async function resumeNativeBackgroundGenerations(): Promise<void> {
  if (CHATBOX_BUILD_PLATFORM !== 'android') return

  const tasks = await listNativeStreamTasks()
  const latestTaskByMessage = new Map<string, (typeof tasks)[number]>()
  const supersededTasks: typeof tasks = []
  for (const task of tasks) {
    if (!task.sessionId || !task.messageId) continue
    const key = `${task.sessionId}:${task.messageId}`
    const current = latestTaskByMessage.get(key)
    if (!current || task.createdAt > current.createdAt) {
      if (current) supersededTasks.push(current)
      latestTaskByMessage.set(key, task)
    } else {
      supersededTasks.push(task)
    }
  }

  for (const task of supersededTasks) {
    if (task.state === 'pending' || task.state === 'running') {
      await cancelNativeStream(task.id)
    } else {
      await acknowledgeNativeStreams([task.id])
    }
  }

  for (const task of latestTaskByMessage.values()) {
    if (!task.sessionId || !task.messageId || recoveringStreamIds.has(task.id)) continue

    const session = await chatStore.getSession(task.sessionId)
    const location = session ? findMessageLocation(session, task.messageId) : null
    const message = location ? location.list[location.index] : undefined
    if (!message?.generating) {
      if (task.state === 'pending' || task.state === 'running') {
        await cancelNativeStream(task.id)
      } else {
        await acknowledgeNativeStreams([task.id])
      }
      continue
    }

    recoveringStreamIds.add(task.id)
    void resumeNativeBackgroundGeneration(task.sessionId, message, task.id)
      .catch((error) => {
        console.error(`Failed to recover background stream ${task.id}:`, error)
      })
      .finally(() => {
        recoveringStreamIds.delete(task.id)
      })
  }
}
