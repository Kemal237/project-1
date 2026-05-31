# CS2 Auto-Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically apply CS2 performance optimizations (boost.cfg, autoexec.cfg, cs2_machine_convars.vcfg, extended launch flags) on every `Launch CS2` call, silently, with no user action required.

**Architecture:** New standalone module `CS2Optimizer.js` is called from `CS2Launcher.start()` right after `_patchCS2VideoSettings()`. It writes three config files to the sandboxed CS2 cfg folder and caches GPU vendor in memory. `CS2_FLAGS` in `CS2Launcher.js` gets three new flags and loses three that move into `boost.cfg`.

**Tech Stack:** Node.js ESM, `child_process.execSync` for PowerShell WMI, `fs` for file ops — all already used in this codebase.

**Spec:** `docs/superpowers/specs/2026-05-31-cs2-auto-optimization-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| **Create** | `src/main/modules/CS2Optimizer.js` | GPU detection, boost.cfg, autoexec.cfg, machine_convars |
| **Modify** | `src/main/modules/CS2Launcher.js` | Add import, update CS2_FLAGS, call optimizer |

---

## Task 1: Create CS2Optimizer.js

**Files:**
- Create: `src/main/modules/CS2Optimizer.js`

- [ ] **Step 1: Create the file with full implementation**

Create `src/main/modules/CS2Optimizer.js` with this exact content:

```js
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
```

- [ ] **Step 2: Verify the file exists and has no syntax issues**

Run:
```powershell
node --input-type=module --eval "import './src/main/modules/CS2Optimizer.js'" 2>&1
```
Expected: no output (or only GPU log if WMI runs). If you see a SyntaxError — fix it before continuing.

- [ ] **Step 3: Commit**

```powershell
git add src/main/modules/CS2Optimizer.js
git commit -m "feat: add CS2Optimizer module (boost.cfg, autoexec, machine_convars, GPU detection)"
```

---

## Task 2: Wire CS2Optimizer into CS2Launcher.js

**Files:**
- Modify: `src/main/modules/CS2Launcher.js` — lines 1-11 (imports), lines 28-37 (CS2_FLAGS), lines 162-167 (launch sequence)

- [ ] **Step 1: Add import at the top of CS2Launcher.js**

In `src/main/modules/CS2Launcher.js`, after the existing imports (after line 10 `import inputMutex from './InputMutex'`), add:

```js
import cs2Optimizer from './CS2Optimizer'
```

- [ ] **Step 2: Update CS2_FLAGS — add new flags, remove duplicates**

Replace the current `CS2_FLAGS` block (lines 28–37):

```js
const CS2_FLAGS = [
  '-windowed',
  '-w', CS2_W, '-h', CS2_H,
  '+r_mode_width', CS2_W, '+r_mode_height', CS2_H,
  '-novid',
  '+fps_max', '30',
  '+r_dynamic', '0',
  '+mat_queue_mode', '0',
  '-condebug',
]
```

With:

```js
const CS2_FLAGS = [
  '-windowed',
  '-w', CS2_W, '-h', CS2_H,
  '+r_mode_width', CS2_W, '+r_mode_height', CS2_H,
  '-novid',
  '-nosound',
  '-high',
  '-swapcores',
  '-condebug',
]
```

Reason: `fps_max`, `r_dynamic`, `mat_queue_mode` move to `boost.cfg` (applied via `exec boost`). Three new flags added: `-nosound` (bot doesn't need audio), `-high` (process priority), `-swapcores` (reduces CPU stuttering).

- [ ] **Step 3: Call cs2Optimizer.apply() in the launch sequence**

Find this block in `start()` (around line 162–167):

```js
onStatus('cs2_launching', 'Запуск CS2...')
this._patchCS2VideoSettings(cs2Path)
// GSI config файл — один раз, виден всем боксам через OpenFilePath steamapps.
try { this._writeGsiConfig(cs2Path) } catch (e) {
  console.log('[CS2Launcher] GSI cfg write:', e.message)
}
```

Replace with:

```js
onStatus('cs2_launching', 'Запуск CS2...')
this._patchCS2VideoSettings(cs2Path)
await cs2Optimizer.apply(cs2Path)
// GSI config файл — один раз, виден всем боксам через OpenFilePath steamapps.
try { this._writeGsiConfig(cs2Path) } catch (e) {
  console.log('[CS2Launcher] GSI cfg write:', e.message)
}
```

- [ ] **Step 4: Verify Electron app builds without errors**

Run in the project root:
```powershell
npm run build 2>&1 | Select-Object -Last 20
```
Expected: build completes without errors. If there's an ESM/import error — double-check the import path (`./CS2Optimizer`, no extension needed in electron-vite).

- [ ] **Step 5: Commit**

```powershell
git add src/main/modules/CS2Launcher.js
git commit -m "feat: wire CS2Optimizer into CS2Launcher — extended flags + auto config patch"
```

---

## Manual Verification

After both tasks are done, verify end-to-end by running the panel and launching CS2 for one account:

**1. GPU detection log**
In the dev console / terminal output, find:
```
[CS2Optimizer] GPU: nvidia
[CS2Optimizer] boost.cfg written
[CS2Optimizer] autoexec.cfg patched (exec boost)
[CS2Optimizer] cs2_machine_convars.vcfg written (nvidia)
[CS2Optimizer] Applied to C:\...
```

**2. Check boost.cfg**

Open in Sandboxie NormalFilePath (e.g. `C:\Sandbox\CS2Bot_1\drive\...\game\csgo\cfg\boost.cfg`).
Expected content:
```
fps_max 30
r_dynamic 0
mat_queue_mode 0
r_drawtracers_firstperson 0
cl_showfps 0
con_logfile ""
sv_log_onefile 0
```

**3. Check autoexec.cfg**

Same cfg folder, `autoexec.cfg`. Must contain `exec boost`. Launch CS2 again for the same account — verify `exec boost` is NOT duplicated.

**4. Check cs2_machine_convars.vcfg**

Same folder. Must contain all 7 `setting.*` keys.

**5. Check launch flags in logs**

Find the Sandboxie spawn log line. Must contain `-nosound -high -swapcores`. Must NOT contain `+fps_max`.

**6. CS2 launches successfully**

CS2 starts, GSI reports `cs2_lobby` status. Main success criterion.
