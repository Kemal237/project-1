# Phase 3B-1 (revised): Windows User Accounts Isolation — Design Spec

**Дата:** 2026-05-17
**Замещает:** [Phase 3B-1: CS2 Process Launcher (Sandboxie-based)](./2026-05-15-phase3b1-cs2-launcher-design.md)
**Статус:** Принят к реализации

---

## Место в общем плане

**Phase 3B — реальный фарм XP в CS2** состоит из четырёх подэтапов:

| Этап | Задача | Статус |
|---|---|---|
| **3B-1** | CS2 Process Launcher (изоляция, запуск Steam + CS2) | 🔄 Переделываем (этот спек) |
| 3B-2 | Private lobby 5v5 (bot_add, mp_warmuptime, console commands) | Pending |
| 3B-3 | Humanized movement (движение, прицеливание, периодическая активность) | Pending |
| 3B-4 | Auto drop selection (Service Medal, weekly drops) | Pending |

Этот спек завершает **3B-1**. После реализации запуск Steam + CS2 работает стабильно, и можно браться за 3B-2 (private lobbies) отдельным спеком.

**Совместимость с будущими этапами:**
- 3B-2 потребует отправки console-команд внутрь cs2.exe бота. Текущий дизайн (окна на host desktop, видны UIAutomation) позволяет это через клавиатуру или `cs2.exe -consoleinput` flag — учтено архитектурно.
- 3B-3 потребует SendInput/PostMessage в окна ботов. Поскольку окна находятся в host desktop, стандартные Windows API будут работать.
- 3B-4 не зависит от изоляции — использует GameCoordinator (уже работает в Phase 3A).

---

## Контекст и проблема

Phase 3B-1 реализовала запуск CS2 в Sandboxie-Plus песочнице. На практике **free версия Sandboxie-Plus 5.72.5 не поддерживает Steam/CEF** — при запуске webhelper Steam падает с ошибкой `0x3000 "Непредвиденная ошибка транспорта"`. Решение `NoSecurityIsolation=y` требует supporter certificate (платное). Sandboxie не подходит для production использования панели.

**Альтернативные варианты изучены:** Windows Sandbox (требует Win Pro, тяжело), VirtualBox (тяжело по RAM/GPU), несколько Steam с разными USERPROFILE (HKCU общий — конфликты), kernel HWID spoofers (риск VAC).

**Выбранное решение:** Windows User Accounts. Это стандартный механизм Windows, изолирует HKCU/USERPROFILE/AppData полностью, работает с CEF/Chromium нативно, бесплатно, параллельный запуск из коробки.

## Цель

Заменить Sandboxie-based архитектуру (Phase 3B-1) на Windows User Accounts:
- 1:1 mapping: каждый Steam-аккаунт получает выделенного Windows-юзера `cs2botN`
- Steam запускается от другого юзера через PowerShell `[System.Diagnostics.Process]::Start` с `LoadUserProfile=true`
- Окна Steam/CS2 видны на host desktop (можно наблюдать визуально)
- Автоматическое создание юзера при добавлении аккаунта в панель и удаление при удалении аккаунта

## Не-цели

- HWID spoofing (отдельная задача в будущем)
- QoL фичи: авто-пауза ботов при запуске host CS2, fps_max ограничения, CPU affinity
- Скриншоты/live preview окон ботов в панели
- Поддержка Windows Home (требует Pro+ — но это уже инфраструктура, а не наша задача)
- Pool пользователей (создание заранее) — используется on-demand модель

## Архитектура

### Файловая структура (изменения)

```
src/main/modules/
├── UserAccountManager.js   [NEW]      — управление Windows-юзерами (net user)
├── ProcessLauncher.js      [NEW]      — запуск exe от другого юзера через PS
├── CS2Launcher.js          [REWRITE]  — orchestration без sandboxie
├── SteamConfigPatcher.js   [SIMPLIFY] — убрать patchLoginusers (sandbox-specific)
├── LauncherPool.js         [DELETE]   — больше не нужен (нет слотов)
├── UIAutomation.js         [UPDATE]   — waitForSandboxedProcess → waitForUserProcess
├── AccountManager.js       [UPDATE]   — add() создаёт Windows-юзера, delete() удаляет
├── Database.js             [MIGRATE]  — wipe accounts/drops + add columns
└── SandboxieManager.js     [DELETED]  — уже удалён
```

### Поток данных

**Добавление Steam-аккаунта:**
```
UI (Accounts.jsx)
  → ipc.accounts:add(creds)
  → accountManager.add(creds)
       ├─ генерирует слот N (следующий свободный cs2botN)
       ├─ userAccountManager.createUser('cs2botN')
       │    ├─ net user cs2botN <random_pwd> /add /Y
       │    ├─ wmic … set PasswordExpires=false
       │    └─ reg add SpecialAccounts (скрыть с welcome)
       └─ INSERT INTO accounts(login, password_enc, ..., windows_user, windows_password_enc)
```

**Запуск CS2:**
```
UI (Accounts.jsx) ▶ кнопка "Запустить CS2"
  → ipc.farm:startCS2(id)
  → workerManager.startFarming(id)
  → steamWorker.startFarming()
       ├─ this.stop()  // drop protocol session
       ├─ slot = {windows_user, windows_password} из accounts[id]
       └─ cs2Launcher.start(id, slot, creds)
            ├─ steamPath = detectSteamPath()
            ├─ cs2Path = detectCS2Path(steamPath)
            ├─ patchCS2GSI(cs2Path, gsiPort)  // общий файл, всем юзерам OK
            ├─ icacls steamPath /grant cs2botN:RX /T   // ensure access (idempotent)
            ├─ processLauncher.launchAsUser(
            │     windows_user, windows_password,
            │     "${steamPath}\\steam.exe",
            │     ['-login', creds.login, creds.password, '-silent'],
            │     workingDir=steamPath)
            │   → pid возвращается
            ├─ ждать sleep(8s)
            ├─ _handleSteamGuard()  // через UIAutomation в host desktop
            ├─ ждать sleep(30s) — Steam логинится
            ├─ processLauncher.launchAsUser(steam.exe -applaunch 730 -windowed ...)
            └─ waitForUserProcess('cs2.exe', owner='cs2botN', 180s)
```

**Удаление Steam-аккаунта:**
```
UI → ipc.accounts:delete(id)
  → accountManager.delete(id)
       ├─ workerManager.stop(id) если запущен
       ├─ cs2Launcher.stop(id) если фармит
       ├─ windows_user = SELECT FROM accounts WHERE id=?
       ├─ userAccountManager.deleteUser('cs2botN')
       │    ├─ net user cs2botN /delete
       │    ├─ reg delete SpecialAccounts
       │    └─ rmdir /S /Q C:\Users\cs2botN
       └─ DELETE FROM accounts/drops WHERE id=?
```

### Компонент: UserAccountManager.js

**Ответственность:** CRUD для локальных Windows-пользователей с префиксом `cs2bot`.

**Public API:**
- `async createUser(username)` → `{ username, password }` — создаёт юзера с рандомным паролем
- `async deleteUser(username)` → удаляет юзера и его профиль C:\Users\<username>
- `async userExists(username)` → boolean
- `async isAdmin()` → boolean (проверка через `whoami /groups`)
- `async listBotUsers()` → string[] — список существующих `cs2bot*`
- `async deleteAllBotUsers()` → number — удаляет всех `cs2bot*`, возвращает количество
- `async getNextAvailableSlot()` → `'cs2botN'` — следующий свободный номер (1, 2, 3...) среди НЕ-созданных в системе

**Внутренние утилиты:**
- `_generatePassword()` — формат `Cs!{16hex}Aa1` (Windows complexity OK)
- `_hideFromLogonScreen(username)` — reg add HKLM\...\SpecialAccounts\UserList
- `_unhideFromLogonScreen(username)`

**Зависимости:** `child_process.exec`, `crypto.randomBytes`. Никаких внешних пакетов.

### Компонент: ProcessLauncher.js

**Ответственность:** Запуск exe от другого Windows-юзера с загруженным профилем.

**Public API:**
- `async launchAsUser(username, password, exePath, args, workingDir)` → `pid`
  Запускает exe через `[System.Diagnostics.Process]::Start` с `ProcessStartInfo.LoadUserProfile=true`, `UseShellExecute=false`, `UserName`/`Password`. Возвращает PID нового процесса.
- `async terminateAllForUser(username)` — `taskkill /F /FI "USERNAME eq <username>" /T`
- `async processIsAlive(pid)` → boolean

**Реализация:** генерируется временный PowerShell-скрипт во `app.getPath('temp')`, выполняется через `powershell -ExecutionPolicy Bypass -File`, временный файл удаляется в finally. PowerShell использует .NET `System.Diagnostics.ProcessStartInfo`.

**Зависимости:** `child_process.exec`, `fs`, `path`, `electron.app`.

### Компонент: CS2Launcher.js (rewrite)

**Ответственность:** Orchestration запуска Steam + CS2 для одного аккаунта.

Сохраняется почти весь существующий код, меняются только два места:
1. Удаляются вызовы `sandboxieManager.*` и `steamConfigPatcher.patchLoginusers()`
2. Вместо `spawn(sandboxieStartExe, [...])` используется `processLauncher.launchAsUser(...)`
3. Проверка transport error 0x3000 — удаляется (с user accounts её не бывает)
4. `waitForSandboxedProcess` → `waitForUserProcess` (новая функция в UIAutomation)

GSI handling, Steam Guard (TOTP + панельный modal), cancellation, события `gsiState`/`steamGuardRequired` — без изменений.

**Изменения сигнатуры `start()`:**
- Аргумент `slot` теперь содержит `{ windows_user, windows_password }` вместо `{ sandbox }`
- Slot теперь — это просто credential pair, не отдельная сущность в БД

### Компонент: UIAutomation.js (update)

**Меняется:**
- `waitForSandboxedProcess(_startExe, _sandbox, processName, timeoutMs, expectedArg)` → `waitForUserProcess(windowsUser, processName, timeoutMs, expectedArg)`
- Фильтр по PROCESS owner через WMI: `Get-CimInstance Win32_Process | ForEach-Object { $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; if ($owner.User -eq 'cs2botN' -and $_.CommandLine -like '*-login*') { ... } }`

Остальные функции (`findWindowByTitle`, `typeIntoWindow`, `waitWindowGone`) не меняются — они работают в host desktop, видят все окна.

### Компонент: SteamConfigPatcher.js (simplify)

**Удаляется:** `patchLoginusers(sandbox, steamPath, creds)` (sandbox-specific).

Steam залогинится сам через флаг `-login user pass`, никаких VDF файлов писать не нужно — каждый Windows-юзер имеет свой пустой `%USERPROFILE%\AppData\Roaming\Valve\Steam`, Steam создаст всё с нуля.

**Остаётся:** `detectSteamPath`, `detectCS2Path`, `patchCS2GSI`.

### Компонент: AccountManager.js (update)

**В методе `add(data)`:**
- После INSERT в БД, до возврата:
  ```js
  const username = await userAccountManager.getNextAvailableSlot()
  const { password } = await userAccountManager.createUser(username)
  this.update(id, { windows_user: username, windows_password_enc: db.encrypt(password) })
  ```
- При ошибке создания юзера → откат: DELETE из accounts, throw

**В методе `delete(id)`:**
- Перед DELETE:
  ```js
  await workerManager.stop(id).catch(() => {})  // если запущен
  const acc = this.getById(id)
  if (acc.windows_user) {
    await userAccountManager.deleteUser(acc.windows_user).catch(err => console.log(...))
  }
  ```

**В методе `getCredentials(id)`:**
- Добавить `windows_user` и `windows_password` (decrypt) в возвращаемый объект.

### Компонент: Database.js (migrate)

**Миграция при старте (one-shot, идемпотентная):**

```js
// 1. Wipe старых данных согласно решению пользователя
this.db.run('DELETE FROM accounts')
this.db.run('DELETE FROM drops')
this.db.run('DROP TABLE IF EXISTS launcher_slots')

// 2. Добавить новые колонки если их нет
const cols = this.all("PRAGMA table_info(accounts)").map(c => c.name)
if (!cols.includes('windows_user'))
  this.db.run('ALTER TABLE accounts ADD COLUMN windows_user TEXT')
if (!cols.includes('windows_password_enc'))
  this.db.run('ALTER TABLE accounts ADD COLUMN windows_password_enc TEXT')

// 3. Удалить sandbox-specific settings
this.db.run("DELETE FROM settings WHERE key='sandboxie_path'")
```

Миграция запускается каждый раз — но `DELETE FROM accounts` срабатывает только при наличии маркера. Чтобы не удалять заново при повторных запусках, использовать setting-маркер:
```js
if (settings.get('migrated_to_user_accounts') !== 'true') {
  // ... выше код миграции ...
  settings.set('migrated_to_user_accounts', 'true')
}
```

### IPC и Preload

**Удаляется (из ipc.js и preload):**
- Namespace `sandboxie.*`: `status`, `install`, `uninstall`, `slots`, `addSlot`, `removeSlot`, `detectPaths`, `onInstallProgress`
- Handler `sandboxie:*`

**Добавляется:**
- `ipc.handle('launcher:status', () => ({ adminMode: await userAccountManager.isAdmin(), users: await userAccountManager.listBotUsers() }))`
- `ipc.handle('launcher:detectPaths', ...)` (переезд из `sandboxie:detectPaths`)
- `ipc.handle('launcher:deleteAllUsers', () => userAccountManager.deleteAllBotUsers())`
- Preload: namespace `launcher.*` вместо `sandboxie.*`

**Не меняется:** `farm.startCS2`, `farm.stopCS2`, `farm.sandboxGuardCode`, `farm.onSandboxGuard` — переименуем sandbox→cs2 для ясности (`farm.cs2GuardCode`, `farm.onCs2Guard`), но логика та же.

### Settings.jsx (UI update)

**Удаляется:**
- Кнопка "Установить Sandboxie" + progress bar
- Кнопка "Удалить Sandboxie"
- Поле "Путь к Sandboxie вручную"
- Секция "Слоты запуска" (с add/remove slot inputs)

**Добавляется:**
- Бейдж "Режим админа: ✓ Активен / ✗ Не активен" (если не админ — show warning что CS2-запуск работать не будет)
- Список созданных Windows-юзеров (read-only: `cs2bot1`, `cs2bot2`, ... — для информации)
- Кнопка "🗑 Удалить всех Windows-юзеров панели" (опасная, с confirm-диалогом — для полной очистки)

**Остаётся:**
- Steam path / CS2 path inputs с автоопределением
- Все остальные секции (фарм группы, задержки, лицензия)

### main/index.js (startup)

**Удаляется:**
- `launcherPool.releaseAll() / .fixSandboxNames() / .ensureDefaultSlot()`
- `sandboxieManager.detectInstall()`
- `sandboxieManager.startDialogWatcher()`

**Добавляется:**
- Проверка `userAccountManager.isAdmin()` при старте → если нет, в console.warn (UI покажет статус)
- Миграция БД через Database.js (срабатывает в `db.init()`)

## Обработка ошибок

| Ошибка | Где обрабатывается | Поведение |
|---|---|---|
| Не админ при `createUser` | UserAccountManager.createUser | throw `'Требуются права админа'` |
| `net user` упал | UserAccountManager | throw с message |
| `processLauncher.launchAsUser` упал | CS2Launcher.start | cleanup: terminateAllForUser, throw в UI |
| Steam Guard timeout | CS2Launcher._handleSteamGuard | _fatal error в воркере |
| CS2 не загрузилась за 3 мин | CS2Launcher.start | cleanup + throw |
| Пользователь нажал Stop | через `entry.cancelled` flag | штатная отмена, не error |
| Удаление юзера упало (юзер залогинен) | AccountManager.delete | warn в console, всё равно DELETE из БД |

## Безопасность

- Пароли Windows-юзеров никогда не отображаются в UI
- Пароли шифруются AES-256-GCM (`db.encrypt()`) — ключ от hostname/platform/arch
- Юзеры скрыты с welcome screen (HKLM SpecialAccounts) — не видны при логине
- ВСЕ пользователи в группе Users (без админ-прав) — изоляция
- `taskkill /F /FI "USERNAME eq cs2botN"` — гарантированно убивает только процессы того юзера
- При удалении панели — отдельный action удаляет всех `cs2bot*`

## Тестирование (manual checklist)

После реализации:

1. ✅ Запустить панель не от админа → UI показывает "Не админ", кнопка "Запустить CS2" disabled или показывает warning
2. ✅ Запустить от админа → "Режим админа: Активен"
3. ✅ Добавить новый Steam-аккаунт → проверить через `net user` что `cs2bot1` создан
4. ✅ В Settings → список юзеров показывает `cs2bot1`
5. ✅ Кликнуть "Запустить CS2" → Steam стартует **без 0x3000 ошибки**, окно видно
6. ✅ Steam Guard диалог появляется → автоввод TOTP работает (если sharedSecret) или panel modal
7. ✅ CS2 запускается в маленьком окне 1024×768
8. ✅ В Task Manager: процессы steam.exe и cs2.exe — User Name: cs2bot1
9. ✅ Кликнуть Stop CS2 → все процессы cs2bot1 завершаются
10. ✅ Удалить аккаунт из панели → `net user cs2bot1` возвращает "пользователь не найден", C:\Users\cs2bot1 удалён
11. ✅ Добавить второй аккаунт → cs2bot2 (не cs2bot1 повторно)
12. ✅ Запустить оба параллельно → 2 Steam'а + 2 CS2 работают одновременно
13. ✅ Host Steam (от kemal) можно запустить параллельно — не конфликтует

## Открытые вопросы / риски

1. **Первый запуск нового Windows-юзера медленный** (~10-30 сек создание профиля). Решение: показать в UI индикатор прогресса при добавлении аккаунта.
2. **CS2 может не запуститься если несколько Steam клиентов одновременно делят CS2-инсталляцию.** Risk mitigation: тестировать на ранних этапах с 2-3 параллельными запусками; если выявится — изолировать через копии или symlinks. **YAGNI до выявления проблемы.**
3. **PowerShell `Start-Process -Credential`** требует параметр `-LoadUserProfile`. Если профиль не успел создаться (первый запуск юзера) — может зависнуть. Решение: создавать тестовый запуск `cmd /c exit` при createUser чтобы прогреть профиль.
4. **UIAutomation работает в host desktop session.** Окна сторонних юзеров там видны если они interactive. Должно работать с `LoadUserProfile=true`, но требует ручной проверки.
