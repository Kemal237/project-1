import { execSync } from 'child_process'
import { existsSync, createWriteStream } from 'fs'
import https from 'https'
import path from 'path'
import { tmpdir } from 'os'

const INSTALL_PATHS = [
  'C:\\Program Files\\Sandboxie',
  'C:\\Program Files\\Sandboxie-Plus',
  'C:\\Program Files (x86)\\Sandboxie',
]

class SandboxieManager {
  isInstalled() {
    if (existsSync('C:\\Windows\\SbieDll.dll')) return true
    return INSTALL_PATHS.some(p => existsSync(p))
  }

  getVersion() {
    try {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Sandboxie" /v "Version"',
        { encoding: 'utf8', timeout: 3000 }
      )
      const m = out.match(/Version\s+REG_SZ\s+(.+)/)
      return m ? m[1].trim() : null
    } catch {
      // try exe version as fallback
      for (const base of INSTALL_PATHS) {
        const exe = path.join(base, 'SbieCtrl.exe')
        if (existsSync(exe)) return 'Установлен'
      }
      return null
    }
  }

  getStatus() {
    const installed = this.isInstalled()
    return { installed, version: installed ? this.getVersion() : null }
  }

  uninstall() {
    for (const base of INSTALL_PATHS) {
      const uninstaller = path.join(base, 'uninstall.exe')
      if (existsSync(uninstaller)) {
        execSync(`"${uninstaller}" /S`, { timeout: 60_000 })
        return true
      }
    }
    throw new Error('Деинсталлятор Sandboxie не найден')
  }

  async install(onProgress) {
    onProgress('Получение информации о последнем релизе...')

    const releases = await this._fetchJson(
      'https://api.github.com/repos/sandboxie-plus/Sandboxie/releases?per_page=50'
    )

    let asset = null
    for (const rel of releases) {
      asset = rel.assets?.find(
        a => /Classic.*x64/i.test(a.name) && a.name.endsWith('.exe')
      )
      if (asset) break
    }

    if (!asset) throw new Error('Инсталлятор Sandboxie Classic x64 не найден на GitHub')

    onProgress(`Скачивание ${asset.name}...`)
    const dest = path.join(tmpdir(), asset.name)
    await this._download(asset.browser_download_url, dest, pct =>
      onProgress(`Скачивание... ${pct}%`)
    )

    onProgress('Установка Sandboxie (может появиться запрос UAC)...')
    try {
      execSync(
        `powershell -Command "Start-Process '${dest}' -ArgumentList '/S' -Verb RunAs -Wait"`,
        { timeout: 120000 }
      )
    } catch {
      execSync(`"${dest}" /S`, { timeout: 120000 })
    }

    onProgress('Проверка установки...')
    if (!this.isInstalled()) throw new Error('Установка завершена, но Sandboxie не обнаружен. Попробуйте запустить панель от имени администратора.')

    return true
  }

  _fetchJson(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'CS2FarmPanel/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._fetchJson(res.headers.location).then(resolve).catch(reject)
        }
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
        res.on('error', reject)
      })
        .on('error', reject)
        .setTimeout(15000, function () { this.destroy(); reject(new Error('Timeout')) })
    })
  }

  _download(url, dest, onPct) {
    return new Promise((resolve, reject) => {
      const follow = u => {
        https.get(u, { headers: { 'User-Agent': 'CS2FarmPanel/1.0' } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return follow(res.headers.location)
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))

          const total = parseInt(res.headers['content-length'] || '0', 10)
          let received = 0
          const ws = createWriteStream(dest)

          res.on('data', c => {
            received += c.length
            if (total > 0) onPct(Math.round((received / total) * 100))
          })
          res.pipe(ws)
          ws.on('finish', resolve)
          ws.on('error', reject)
          res.on('error', reject)
        }).on('error', reject)
      }
      follow(url)
    })
  }
}

export default new SandboxieManager()
