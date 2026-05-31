import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

let _gpuVendor = null

class CS2Optimizer {
  async detectGPUVendor() {
    if (_gpuVendor !== null) {
      console.log(`[CS2Optimizer] GPU: ${_gpuVendor} (cached)`)
      return _gpuVendor
    }
    try {
      const out = execSync(
        'powershell -NoProfile -Command "Get-WmiObject Win32_VideoController | Select-Object -ExpandProperty Name"',
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).toUpperCase()
      if (out.includes('NVIDIA')) _gpuVendor = 'nvidia'
      else if (out.includes('AMD') || out.includes('RADEON')) _gpuVendor = 'amd'
      else if (out.includes('INTEL')) _gpuVendor = 'intel'
      else _gpuVendor = 'unknown'
    } catch {
      _gpuVendor = 'unknown'
    }
    console.log(`[CS2Optimizer] GPU: ${_gpuVendor}`)
    return _gpuVendor
  }

  _writeBoostCfg(cfgDir) {
    const content = [
      'fps_max 30',
      'r_dynamic 0',
      'mat_queue_mode 0',
      'r_drawtracers_firstperson 0',
      'cl_showfps 0',
      'con_logfile ""',
      'sv_log_onefile 0',
      '',
    ].join('\n')
    writeFileSync(join(cfgDir, 'boost.cfg'), content, 'utf8')
    console.log('[CS2Optimizer] boost.cfg written')
  }

  _patchAutoexec(cfgDir) {
    const filePath = join(cfgDir, 'autoexec.cfg')
    let content = ''
    try { content = readFileSync(filePath, 'utf8') } catch { /* file doesn't exist yet */ }
    if (content.includes('exec boost')) {
      console.log('[CS2Optimizer] autoexec.cfg already has exec boost, skipping')
      return
    }
    const newContent = content ? content.trimEnd() + '\nexec boost\n' : 'exec boost\n'
    writeFileSync(filePath, newContent, 'utf8')
    console.log('[CS2Optimizer] autoexec.cfg patched (exec boost)')
  }

  _writeMachineConvars(cfgDir, vendor) {
    const content = [
      '"cs2_machine_convars"',
      '{',
      '  "setting.gpu_mem_level"           "0"',
      '  "setting.mat_antialias"            "0"',
      '  "setting.mat_aaquality"            "0"',
      '  "setting.gpu_level"                "0"',
      '  "setting.cpu_level"                "0"',
      '  "setting.mat_vsync"                "0"',
      '  "setting.mat_motion_blur_enabled"  "0"',
      '}',
      '',
    ].join('\n')
    writeFileSync(join(cfgDir, 'cs2_machine_convars.vcfg'), content, 'utf8')
    console.log(`[CS2Optimizer] cs2_machine_convars.vcfg written (${vendor})`)
  }

  async apply(cs2Path) {
    if (!cs2Path || !existsSync(cs2Path)) {
      console.log('[CS2Optimizer] cs2Path not found, skipping')
      return
    }
    const cfgDir = join(cs2Path, 'game', 'csgo', 'cfg')
    try { mkdirSync(cfgDir, { recursive: true }) } catch {}

    const vendor = await this.detectGPUVendor()

    try { this._writeBoostCfg(cfgDir) } catch (e) {
      console.log('[CS2Optimizer] boost.cfg write failed:', e.message)
    }
    try { this._patchAutoexec(cfgDir) } catch (e) {
      console.log('[CS2Optimizer] autoexec.cfg patch failed:', e.message)
    }
    try { this._writeMachineConvars(cfgDir, vendor) } catch (e) {
      console.log('[CS2Optimizer] cs2_machine_convars.vcfg write failed:', e.message)
    }

    console.log(`[CS2Optimizer] Applied to ${cs2Path}`)
  }
}

export default new CS2Optimizer()
