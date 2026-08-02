import { Capacitor, registerPlugin } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { SafeArea } from 'capacitor-plugin-safe-area'

interface RoundedCorners {
  supported: boolean
  topLeft: number
  topRight: number
  bottomRight: number
  bottomLeft: number
}

interface ScreenGeometryPlugin {
  getRoundedCorners(): Promise<RoundedCorners>
  getSystemGestureInsets(): Promise<{
    left: number
    top: number
    right: number
    bottom: number
    edgeNavigation: boolean
  }>
}

const ScreenGeometry = registerPlugin<ScreenGeometryPlugin>('ScreenGeometry')
const DEFAULT_DOCK_RADIUS = 26

function setSafeAreaInsets(insets: { top: number; right: number; bottom: number; left: number }) {
  for (const [key, value] of Object.entries(insets)) {
    document.documentElement.style.setProperty(`--mobile-safe-area-inset-${key}`, `${value}px`)
  }
}

function setDockRadius(deviceRadius: number) {
  const radius = deviceRadius > 0 ? Math.min(32, Math.max(22, Math.round(deviceRadius * 0.62))) : DEFAULT_DOCK_RADIUS
  document.documentElement.style.setProperty('--mobile-device-corner-radius', `${deviceRadius}px`)
  document.documentElement.style.setProperty('--mobile-dock-corner-radius', `${radius}px`)
}

async function refreshRoundedCorners() {
  if (Capacitor.getPlatform() !== 'android') {
    setDockRadius(0)
    return
  }
  try {
    const corners = await ScreenGeometry.getRoundedCorners()
    const bottomRadii = [corners.bottomLeft, corners.bottomRight].filter((radius) => radius > 0)
    setDockRadius(bottomRadii.length > 0 ? Math.min(...bottomRadii) : 0)
  } catch (error) {
    console.warn('Failed to read Android screen corner radius:', error)
    setDockRadius(0)
  }
}

async function refreshSystemGestureInsets() {
  if (Capacitor.getPlatform() !== 'android') {
    document.documentElement.dataset.systemGestureNavigation = 'false'
    return
  }
  try {
    const insets = await ScreenGeometry.getSystemGestureInsets()
    document.documentElement.dataset.systemGestureNavigation = String(insets.edgeNavigation)
    for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
      document.documentElement.style.setProperty(`--mobile-system-gesture-inset-${edge}`, `${insets[edge]}px`)
    }
  } catch (error) {
    document.documentElement.dataset.systemGestureNavigation = 'false'
    console.warn('Failed to read Android system gesture insets:', error)
  }
}

void SafeArea.getSafeAreaInsets().then(({ insets }) => {
  setSafeAreaInsets(insets)
})
void refreshRoundedCorners()
void refreshSystemGestureInsets()

void SafeArea.addListener('safeAreaChanged', ({ insets }) => {
  setSafeAreaInsets(insets)
  void refreshRoundedCorners()
  void refreshSystemGestureInsets()
})

void Keyboard.addListener('keyboardWillShow', () => {
  document.documentElement.dataset.keyboardVisible = 'true'
  document.documentElement.style.setProperty('--mobile-safe-area-inset-bottom', '0px')
})

void Keyboard.addListener('keyboardWillHide', () => {
  document.documentElement.dataset.keyboardVisible = 'false'
  void SafeArea.getSafeAreaInsets().then(({ insets }) => {
    setSafeAreaInsets(insets)
  })
})

window.addEventListener('resize', () => {
  void refreshRoundedCorners()
  void refreshSystemGestureInsets()
})
