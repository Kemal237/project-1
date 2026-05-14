"use strict";
const electron = require("electron");
const path = require("path");
const initSqlJs = require("sql.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const https = require("https");
const socksProxyAgent = require("socks-proxy-agent");
class Database {
  constructor() {
    this._key = this._deriveKey();
    this._dbPath = null;
    this.db = null;
  }
  async init() {
    this._dbPath = path.join(electron.app.getPath("userData"), "farm.db");
    const SQL = await initSqlJs();
    this.db = fs.existsSync(this._dbPath) ? new SQL.Database(fs.readFileSync(this._dbPath)) : new SQL.Database();
    this._migrate();
    setInterval(() => this._save(), 3e4);
  }
  _save() {
    if (!this.db) return;
    fs.writeFileSync(this._dbPath, Buffer.from(this.db.export()));
  }
  _deriveKey() {
    return crypto.createHash("sha256").update([os.hostname(), os.platform(), os.arch(), "cs2fp_v1"].join("|")).digest();
  }
  encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", this._key, iv);
    const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
  }
  decrypt(data) {
    if (!data) return null;
    try {
      const buf = Buffer.from(data, "base64");
      const iv = buf.slice(0, 16);
      const tag = buf.slice(16, 32);
      const enc = buf.slice(32);
      const decipher = crypto.createDecipheriv("aes-256-gcm", this._key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(enc).toString("utf8") + decipher.final("utf8");
    } catch {
      return null;
    }
  }
  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }
  run(sql, params = []) {
    this.db.run(sql, params);
    this._save();
    const r = this.db.exec("SELECT last_insert_rowid()");
    return { lastInsertRowid: r[0]?.values[0][0] };
  }
  _migrate() {
    this.db.run(`CREATE TABLE IF NOT EXISTS accounts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      login               TEXT NOT NULL UNIQUE,
      password_enc        TEXT,
      shared_secret_enc   TEXT,
      identity_secret_enc TEXT,
      refresh_token_enc   TEXT,
      proxy_id            INTEGER,
      status              TEXT DEFAULT 'idle',
      xp_progress         INTEGER DEFAULT 0,
      drops_total         INTEGER DEFAULT 0,
      drops_this_week     INTEGER DEFAULT 0,
      last_drop_at        TEXT,
      last_login_at       TEXT,
      is_prime            INTEGER DEFAULT 0,
      is_limited          INTEGER DEFAULT 0,
      warmup_week         INTEGER DEFAULT 0,
      notes               TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS proxies (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host            TEXT NOT NULL,
      port            INTEGER NOT NULL,
      username        TEXT,
      password_enc    TEXT,
      type            TEXT DEFAULT 'socks5',
      is_valid        INTEGER DEFAULT 1,
      last_ip         TEXT,
      last_checked_at TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS drops (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id   INTEGER NOT NULL,
      item_name    TEXT NOT NULL,
      item_type    TEXT,
      assetid      TEXT,
      classid      TEXT,
      market_price REAL DEFAULT 0,
      dropped_at   TEXT DEFAULT (datetime('now'))
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`);
    const defaults = {
      batch_size: "10",
      min_batch_delay: "30",
      max_batch_delay: "90",
      min_login_delay: "15",
      max_login_delay: "45",
      session_min_hours: "2",
      session_max_hours: "4",
      license_key: "",
      license_status: "inactive"
    };
    for (const [k, v] of Object.entries(defaults))
      this.db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [k, v]);
    this._save();
  }
}
const db = new Database();
class AccountManager {
  getAll() {
    return db.all(`
      SELECT a.id, a.login, a.proxy_id, a.status, a.xp_progress,
             a.drops_total, a.drops_this_week, a.last_drop_at, a.last_login_at,
             a.is_prime, a.is_limited, a.warmup_week, a.notes, a.created_at,
             p.host AS proxy_host, p.port AS proxy_port,
             p.username AS proxy_user, p.type AS proxy_type, p.is_valid AS proxy_valid
      FROM accounts a LEFT JOIN proxies p ON a.proxy_id = p.id
      ORDER BY a.created_at DESC
    `).map((r) => ({
      id: r.id,
      login: r.login,
      status: r.status,
      xpProgress: r.xp_progress,
      dropsTotal: r.drops_total,
      dropsThisWeek: r.drops_this_week,
      lastDropAt: r.last_drop_at,
      lastLoginAt: r.last_login_at,
      isPrime: !!r.is_prime,
      isLimited: !!r.is_limited,
      warmupWeek: r.warmup_week,
      notes: r.notes,
      createdAt: r.created_at,
      proxy: r.proxy_host ? {
        id: r.proxy_id,
        host: r.proxy_host,
        port: r.proxy_port,
        username: r.proxy_user,
        type: r.proxy_type,
        isValid: !!r.proxy_valid
      } : null
    }));
  }
  add(data) {
    const { login, password, sharedSecret, identitySecret, proxyId, isPrime, notes } = data;
    if (!login || !password) throw new Error("login и password обязательны");
    const r = db.run(`
      INSERT INTO accounts (login, password_enc, shared_secret_enc, identity_secret_enc, proxy_id, is_prime, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      login.trim(),
      db.encrypt(password),
      db.encrypt(sharedSecret || ""),
      db.encrypt(identitySecret || ""),
      proxyId || null,
      isPrime ? 1 : 0,
      notes || null
    ]);
    return { id: r.lastInsertRowid, login: login.trim() };
  }
  update(id, data) {
    const map = {
      password: ["password_enc", (v) => db.encrypt(v)],
      sharedSecret: ["shared_secret_enc", (v) => db.encrypt(v)],
      identitySecret: ["identity_secret_enc", (v) => db.encrypt(v)],
      refreshToken: ["refresh_token_enc", (v) => db.encrypt(v)],
      proxyId: ["proxy_id", (v) => v],
      status: ["status", (v) => v],
      xpProgress: ["xp_progress", (v) => v],
      dropsTotal: ["drops_total", (v) => v],
      dropsThisWeek: ["drops_this_week", (v) => v],
      lastDropAt: ["last_drop_at", (v) => v],
      lastLoginAt: ["last_login_at", (v) => v],
      isPrime: ["is_prime", (v) => v ? 1 : 0],
      isLimited: ["is_limited", (v) => v ? 1 : 0],
      warmupWeek: ["warmup_week", (v) => v],
      notes: ["notes", (v) => v]
    };
    const fields = [], values = [];
    for (const [key, [col, fn]] of Object.entries(map))
      if (data[key] !== void 0) {
        fields.push(`${col} = ?`);
        values.push(fn(data[key]));
      }
    if (!fields.length) return;
    values.push(id);
    db.run(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`, values);
  }
  delete(id) {
    db.run("DELETE FROM accounts WHERE id = ?", [id]);
  }
  importFromText(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const result = { success: 0, failed: 0, errors: [] };
    for (const line of lines) {
      try {
        const [login, password, sharedSecret = "", identitySecret = ""] = line.split(":");
        if (!login || !password) throw new Error("Нужны минимум login:password");
        this.add({ login, password, sharedSecret, identitySecret });
        result.success++;
      } catch (e) {
        result.failed++;
        result.errors.push(`${line.slice(0, 30)}: ${e.message}`);
      }
    }
    return result;
  }
  getCredentials(id) {
    const r = db.get("SELECT * FROM accounts WHERE id = ?", [id]);
    if (!r) return null;
    return {
      id: r.id,
      login: r.login,
      password: db.decrypt(r.password_enc),
      sharedSecret: db.decrypt(r.shared_secret_enc),
      identitySecret: db.decrypt(r.identity_secret_enc),
      refreshToken: db.decrypt(r.refresh_token_enc),
      proxyId: r.proxy_id,
      isPrime: !!r.is_prime,
      warmupWeek: r.warmup_week
    };
  }
  saveRefreshToken(id, token) {
    db.run(
      `UPDATE accounts SET refresh_token_enc = ?, last_login_at = datetime('now') WHERE id = ?`,
      [db.encrypt(token), id]
    );
  }
  incrementDrop(id) {
    db.run(`UPDATE accounts SET drops_total = drops_total + 1, drops_this_week = drops_this_week + 1,
            last_drop_at = datetime('now') WHERE id = ?`, [id]);
  }
}
const accountManager = new AccountManager();
class ProxyManager {
  getAll() {
    return db.all(`
      SELECT p.id, p.host, p.port, p.username, p.type,
             p.is_valid, p.last_ip, p.last_checked_at, p.created_at,
             COUNT(a.id) AS accounts_count
      FROM proxies p LEFT JOIN accounts a ON a.proxy_id = p.id
      GROUP BY p.id ORDER BY p.created_at DESC
    `).map((r) => ({
      id: r.id,
      host: r.host,
      port: r.port,
      username: r.username,
      type: r.type,
      isValid: !!r.is_valid,
      lastIp: r.last_ip,
      lastCheckedAt: r.last_checked_at,
      accountsCount: r.accounts_count,
      createdAt: r.created_at
    }));
  }
  add(data) {
    const { host, port, username, password, type = "socks5" } = data;
    if (!host || !port) throw new Error("host и port обязательны");
    const r = db.run(
      "INSERT INTO proxies (host, port, username, password_enc, type) VALUES (?, ?, ?, ?, ?)",
      [host.trim(), parseInt(port), username || null, db.encrypt(password || ""), type]
    );
    return { id: r.lastInsertRowid };
  }
  delete(id) {
    db.run("UPDATE accounts SET proxy_id = NULL WHERE proxy_id = ?", [id]);
    db.run("DELETE FROM proxies WHERE id = ?", [id]);
  }
  assign(proxyId, accountId) {
    db.run("UPDATE accounts SET proxy_id = ? WHERE id = ?", [proxyId || null, accountId]);
  }
  validate(data) {
    const { host, port, username, password, type = "socks5" } = data;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ valid: false, error: "Timeout (8s)" }), 8e3);
      try {
        const auth = username ? `${username}:${password}@` : "";
        const agent = new socksProxyAgent.SocksProxyAgent(`${type}://${auth}${host}:${port}`);
        const req = https.request({ hostname: "api.ipify.org", path: "/?format=json", method: "GET", agent, timeout: 7e3 }, (res) => {
          let body = "";
          res.on("data", (d) => body += d);
          res.on("end", () => {
            clearTimeout(timer);
            try {
              const { ip } = JSON.parse(body);
              resolve({ valid: true, ip });
            } catch {
              resolve({ valid: false, error: "Неверный ответ" });
            }
          });
        });
        req.on("error", (e) => {
          clearTimeout(timer);
          resolve({ valid: false, error: e.message });
        });
        req.on("timeout", () => {
          req.destroy();
          resolve({ valid: false, error: "Timeout" });
        });
        req.end();
      } catch (e) {
        clearTimeout(timer);
        resolve({ valid: false, error: e.message });
      }
    });
  }
  getProxyUrl(proxyId) {
    if (!proxyId) return null;
    const r = db.get("SELECT * FROM proxies WHERE id = ?", [proxyId]);
    if (!r) return null;
    const pass = db.decrypt(r.password_enc);
    const auth = r.username ? `${r.username}:${pass}@` : "";
    return `${r.type}://${auth}${r.host}:${r.port}`;
  }
}
const proxyManager = new ProxyManager();
class Settings {
  getAll() {
    return Object.fromEntries(db.all("SELECT key, value FROM settings").map((r) => [r.key, r.value]));
  }
  get(key) {
    return db.get("SELECT value FROM settings WHERE key = ?", [key])?.value ?? null;
  }
  set(key, value) {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, String(value)]);
  }
}
const settings = new Settings();
class DropTracker {
  saveDrop(accountId, item) {
    db.run(
      "INSERT INTO drops (account_id, item_name, item_type, assetid, classid, market_price) VALUES (?, ?, ?, ?, ?, ?)",
      [accountId, item.name || "Unknown", item.type || null, item.assetid || null, item.classid || null, item.price || 0]
    );
    db.run(`UPDATE accounts SET drops_total = drops_total + 1, drops_this_week = drops_this_week + 1,
            last_drop_at = datetime('now') WHERE id = ?`, [accountId]);
  }
  getAll(limit = 200) {
    return db.all(`SELECT d.id, d.item_name, d.item_type, d.market_price, d.dropped_at, a.login AS account_login
      FROM drops d JOIN accounts a ON d.account_id = a.id ORDER BY d.dropped_at DESC LIMIT ?`, [limit]);
  }
  getByAccount(accountId) {
    return db.all("SELECT * FROM drops WHERE account_id = ? ORDER BY dropped_at DESC", [accountId]);
  }
  getStats() {
    const total = db.get("SELECT COUNT(*) AS cnt, SUM(market_price) AS revenue FROM drops") || {};
    const week = db.get(`SELECT COUNT(*) AS cnt, SUM(market_price) AS revenue FROM drops WHERE dropped_at >= datetime('now', '-7 days')`) || {};
    const byDay = db.all(`SELECT DATE(dropped_at) AS date, COUNT(*) AS count, SUM(market_price) AS revenue
      FROM drops WHERE dropped_at >= datetime('now', '-30 days') GROUP BY DATE(dropped_at) ORDER BY date ASC`);
    const topAccounts = db.all(`SELECT a.login, COUNT(d.id) AS drops, SUM(d.market_price) AS revenue
      FROM drops d JOIN accounts a ON d.account_id = a.id GROUP BY a.id ORDER BY drops DESC LIMIT 10`);
    return {
      total: { count: total.cnt || 0, revenue: total.revenue || 0 },
      thisWeek: { count: week.cnt || 0, revenue: week.revenue || 0 },
      byDay,
      topAccounts
    };
  }
}
const dropTracker = new DropTracker();
function setupIPC() {
  electron.ipcMain.handle("accounts:getAll", () => accountManager.getAll());
  electron.ipcMain.handle("accounts:add", (_, d) => accountManager.add(d));
  electron.ipcMain.handle("accounts:update", (_, id, d) => accountManager.update(id, d));
  electron.ipcMain.handle("accounts:delete", (_, id) => accountManager.delete(id));
  electron.ipcMain.handle("accounts:import", (_, text) => accountManager.importFromText(text));
  electron.ipcMain.handle("proxies:getAll", () => proxyManager.getAll());
  electron.ipcMain.handle("proxies:add", (_, d) => proxyManager.add(d));
  electron.ipcMain.handle("proxies:delete", (_, id) => proxyManager.delete(id));
  electron.ipcMain.handle("proxies:validate", (_, d) => proxyManager.validate(d));
  electron.ipcMain.handle("proxies:assign", (_, pid, aid) => proxyManager.assign(pid, aid));
  electron.ipcMain.handle("settings:get", () => settings.getAll());
  electron.ipcMain.handle("settings:set", (_, k, v) => settings.set(k, v));
  electron.ipcMain.handle("drops:getAll", () => dropTracker.getAll());
  electron.ipcMain.handle("drops:getByAccount", (_, id) => dropTracker.getByAccount(id));
  electron.ipcMain.handle("drops:getStats", () => dropTracker.getStats());
}
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 680,
    frame: false,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"]?.replace("localhost", "127.0.0.1");
  if (devUrl) {
    const tryLoad = (attempts) => {
      win.loadURL(devUrl).catch(() => {
        if (attempts > 0) setTimeout(() => tryLoad(attempts - 1), 500);
      });
    };
    setTimeout(() => tryLoad(20), 1e3);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  return win;
}
electron.app.whenReady().then(async () => {
  await db.init();
  const win = createWindow();
  electron.ipcMain.on("window:minimize", () => win.minimize());
  electron.ipcMain.on("window:maximize", () => win.isMaximized() ? win.unmaximize() : win.maximize());
  electron.ipcMain.on("window:close", () => win.close());
  setupIPC();
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
