import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import platform from '../platform'

function getInitialTime() {
  let initialTime = parseInt(localStorage.getItem('initial-time') || '')
  if (!initialTime) {
    initialTime = Date.now()
    localStorage.setItem('initial-time', `${initialTime}`)
  }

  return initialTime
}

export function isFirstDay(): boolean {
  const initialTime = getInitialTime()
  const today = dayjs()
  const installDay = dayjs(initialTime)
  return today.isSame(installDay, 'day')
}

export default function useVersion() {
  const [version, setVersion] = useState('')

  useEffect(() => {
    void platform.getVersion().then(setVersion)
  }, [])

  return {
    version,
    versionLoaded: !!version,
    // Pure has no store-review masking driven by ChatBox remote configuration.
    isExceeded: false,
    isExceededResolved: true,
    // Kept for compatibility; the Pure updater state lives in updateStore.
    needCheckUpdate: false,
  }
}
