import { ipcMain } from 'electron'
import { getLogger } from './util'

const log = getLogger('app-updater')

/**
 * The legacy Electron updater is intentionally disabled in Pure.
 *
 * All platforms use the repository-owned release-metadata.json checker in the
 * renderer and download complete installation packages from the URLs declared
 * there. These handlers remain only for compatibility with older renderer code.
 */
export class AppUpdater {
  constructor() {
    ipcMain.removeHandler('updater:check')
    ipcMain.handle('updater:check', () => ({ started: false }))

    ipcMain.removeHandler('install-update')
    ipcMain.handle('install-update', () => false)

    log.info('Official auto-updater disabled; Pure release metadata updater is active')
  }
}
