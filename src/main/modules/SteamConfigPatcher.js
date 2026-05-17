import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import settings from './Settings'

const execAsync = promisify(exec)

class SteamConfigPatcher {
  async detectSteamPath() {
    const saved = settings.get('steam_path')
    if (saved && existsSync(join(saved, 'steam.exe'))) return saved

    // Try Windows registry first (most reliable)
    try {
      const { stdout } = await execAsync(
        'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath',
        { encoding: 'utf8' }
      )
      const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/)
      if (match) {
        const regPath = match[1].trim().replace(/\//g, '\\')
        if (existsSync(join(regPath, 'steam.exe'))) {
          settings.set('steam_path', regPath)
          return regPath
        }
      }
    } catch {}

    // Fallback: common install locations
    const candidates = [
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
      join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Steam'),
      join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Steam'),
    ]
    for (const p of candidates) {
      if (existsSync(join(p, 'steam.exe'))) {
        settings.set('steam_path', p)
        return p
      }
    }

    return null
  }

  // Write CS2 GSI config so CS2 reports game state to our local HTTP server.
  // cs2Path is the NormalFilePath in Sandboxie, so the file is shared with the sandboxed process.
  patchCS2GSI(cs2Path, port = 7779) {
    const cfgDir = join(cs2Path, 'game', 'csgo', 'cfg')
    try {
      mkdirSync(cfgDir, { recursive: true })
      const cfg = [
        '"CSGO"',
        '{',
        `  "uri" "http://127.0.0.1:${port}/"`,
        '  "timeout"   "5.0"',
        '  "buffer"    "0.1"',
        '  "throttle"  "0.5"',
        '  "heartbeat" "30.0"',
        '  "output"',
        '  {',
        '    "Game_Map"           "1"',
        '    "Game_Phase"         "1"',
        '    "Round"              "1"',
        '    "Player_Name"        "1"',
        '    "Player_Steamid"     "1"',
        '    "Player_Match_Stats" "1"',
        '    "Team"               "1"',
        '  }',
        '}',
        '',
      ].join('\n')
      writeFileSync(join(cfgDir, 'gamestate_integration_panel.cfg'), cfg, 'utf8')
      console.log('[SteamConfigPatcher] GSI config written to', cfgDir)
    } catch (e) {
      console.log('[SteamConfigPatcher] GSI config write failed:', e.message)
    }
  }

  async detectCS2Path(steamPath) {
    const saved = settings.get('cs2_path')
    if (saved && existsSync(saved)) return saved

    if (!steamPath) return null

    // CS2 is stored as "Counter-Strike Global Offensive" in steamapps
    const candidates = [
      join(steamPath, 'steamapps', 'common', 'Counter-Strike Global Offensive'),
      join(steamPath, 'steamapps', 'common', 'Counter-Strike 2'),
    ]
    for (const p of candidates) {
      if (existsSync(p)) {
        settings.set('cs2_path', p)
        return p
      }
    }

    // Also search across additional Steam library folders (libraryfolders.vdf)
    try {
      const libraryPath = join(steamPath, 'steamapps', 'libraryfolders.vdf')
      if (existsSync(libraryPath)) {
        const { readFileSync } = await import('fs')
        const vdf = readFileSync(libraryPath, 'utf8')
        const paths = [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map(m => m[1].replace(/\\\\/g, '\\'))
        for (const lib of paths) {
          for (const name of ['Counter-Strike Global Offensive', 'Counter-Strike 2']) {
            const p = join(lib, 'steamapps', 'common', name)
            if (existsSync(p)) {
              settings.set('cs2_path', p)
              return p
            }
          }
        }
      }
    } catch {}

    return null
  }
}

export default new SteamConfigPatcher()
