# CS2 Auto-Optimization Design

## Overview

Automatically apply performance optimizations to each CS2 instance at launch time — silently, before Sandboxie starts the process. No user action required. Covers console config, autoexec injection, GPU-specific machine convars, and expanded launch flags.

## Trigger

Every call to `CS2Launcher.launch(accountId)` applies optimization before starting the Sandboxie process. Idempotent — safe to run on every launch because it only writes files (no side effects).

## Architecture

### New module: `src/main/modules/CS2Optimizer.js`

Single responsibility: apply all optimizations given a `cs2Path` (sandboxed CS2 install path). Called by `CS2Launcher.launch()` directly after `_patchCS2VideoSettings()`.

```js
import cs2Optimizer from './CS2Optimizer'
// inside launch():
await this._patchCS2VideoSettings(cs2Path)
await cs2Optimizer.apply(cs2Path)          // ← new
await this._writeGsiConfig(cs2Path)
```

GPU vendor is detected once per app session and cached in module-level memory. Re-detection only happens on next app start.

### Modified: `src/main/modules/CS2Launcher.js`

Extend `CS2_FLAGS` with three new flags:

```js
'-nosound',    // bot doesn't need audio
'-high',       // high process priority
'-swapcores',  // rebind CS2 to physical CPU cores (reduces stuttering)
```

Remove `+fps_max 30`, `+r_dynamic 0`, `+mat_queue_mode 0` from `CS2_FLAGS` — these move to `boost.cfg` to avoid duplication. (They still apply via `exec boost` on game load.)

## CS2Optimizer API

```js
class CS2Optimizer {
  async apply(cs2Path)        // main entry point — writes all files
  async detectGPUVendor()     // WMI query, returns 'nvidia'|'amd'|'intel'|'unknown'
  _writeBoostCfg(cfgDir)      // writes boost.cfg
  _patchAutoexec(cfgDir)      // appends "exec boost" to autoexec.cfg if not present
  _writeMachineConvars(cfgDir, vendor)  // writes cs2_machine_convars.vcfg
}
export default new CS2Optimizer()
```

## Files Written

All paths relative to `cs2Path` (Sandboxie NormalFilePath — already used by `_patchCS2VideoSettings`):

### `game/csgo/cfg/boost.cfg` (overwrite always)

```
fps_max 30
r_dynamic 0
mat_queue_mode 0
r_drawtracers_firstperson 0
cl_showfps 0
con_logfile ""
sv_log_onefile 0
```

Same for all accounts regardless of GPU.

### `game/csgo/cfg/autoexec.cfg` (append-safe)

If file doesn't exist — create with single line `exec boost`.  
If file exists and already contains `exec boost` — skip (no duplicate).  
If file exists without that line — append `\nexec boost`.

### `game/csgo/cfg/cs2_machine_convars.vcfg` (overwrite always)

VDF format. GPU-specific profiles:

**Nvidia:**
```
"cs2_machine_convars"
{
  "setting.gpu_mem_level"       "0"
  "setting.mat_antialias"       "0"
  "setting.mat_aaquality"       "0"
  "setting.gpu_level"           "0"
  "setting.cpu_level"           "0"
  "setting.mat_vsync"           "0"
  "setting.mat_motion_blur_enabled" "0"
}
```

**AMD:**
```
"cs2_machine_convars"
{
  "setting.gpu_mem_level"       "0"
  "setting.mat_antialias"       "0"
  "setting.mat_aaquality"       "0"
  "setting.gpu_level"           "0"
  "setting.cpu_level"           "0"
  "setting.mat_vsync"           "0"
  "setting.mat_motion_blur_enabled" "0"
}
```

**Intel / unknown:** Same keys, same values (minimum quality across the board).

All profiles identical in practice — minimum quality on every setting. Vendor detection feeds into future per-vendor tuning but produces the same output today.

## GPU Detection

PowerShell WMI query via `exec`:

```powershell
Get-WmiObject Win32_VideoController | Select-Object -ExpandProperty Name
```

Parse output:
- Contains "NVIDIA" → `'nvidia'`
- Contains "AMD" or "Radeon" → `'amd'`
- Contains "Intel" → `'intel'`
- Otherwise → `'unknown'`

Result cached in module-level variable `_gpuVendor` (null = not yet detected). Async function, awaited once per `apply()` call.

## Error Handling

- GPU detection failure → log warning, use `'unknown'` profile, continue
- File write failure for any single file → log error with path, continue (don't throw — partial optimization is better than no launch)
- `cs2Path` doesn't exist → log warning, skip silently (CS2 not installed for this account — CS2Launcher will catch this separately)

## Logging

All logs prefixed `[CS2Optimizer]`:
- `[CS2Optimizer] GPU: nvidia (cached)` / `[CS2Optimizer] GPU: nvidia`
- `[CS2Optimizer] Applied to <cs2Path>`
- `[CS2Optimizer] boost.cfg written`
- `[CS2Optimizer] autoexec.cfg patched (exec boost)`
- `[CS2Optimizer] autoexec.cfg already has exec boost, skipping`
- `[CS2Optimizer] cs2_machine_convars.vcfg written (nvidia)`

## Testing Plan

1. **boost.cfg content** — после первого `Launch CS2` проверить файл `<sandboxPath>/drive/c/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg/boost.cfg`: должен содержать все 7 строк.

2. **autoexec.cfg inject** — проверить что `exec boost` появился. Запустить повторно — убедиться что строка не задублировалась.

3. **cs2_machine_convars.vcfg** — проверить содержимое файла, все 7 ключей присутствуют.

4. **Launch flags** — в логах CS2Launcher найти строку с аргументами запуска: должны присутствовать `-nosound`, `-high`, `-swapcores`; не должно быть `+fps_max` (переехало в boost.cfg).

5. **GPU detection** — в логах найти `[CS2Optimizer] GPU:`, второй запуск должен показать `(cached)`.

6. **CS2 запускается** — главная проверка: CS2 стартует без ошибок, GSI отвечает.

## Scope

This spec covers only config patching and launch flags. It does NOT include:
- UI button or indicator for optimization status
- Per-account optimization settings
- Optimization for non-Sandboxie (direct) launch path
