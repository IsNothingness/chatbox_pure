import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.isnothingness.chatboxpure',
  appName: 'ChatBox Pure',
  webDir: 'release/app/dist/renderer',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#ffffff',
      showSpinner: false,
    },
  },
}

export default config
