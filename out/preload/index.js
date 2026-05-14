"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("api", {
  accounts: {
    getAll: () => electron.ipcRenderer.invoke("accounts:getAll"),
    add: (d) => electron.ipcRenderer.invoke("accounts:add", d),
    update: (id, d) => electron.ipcRenderer.invoke("accounts:update", id, d),
    delete: (id) => electron.ipcRenderer.invoke("accounts:delete", id),
    import: (text) => electron.ipcRenderer.invoke("accounts:import", text)
  },
  proxies: {
    getAll: () => electron.ipcRenderer.invoke("proxies:getAll"),
    add: (d) => electron.ipcRenderer.invoke("proxies:add", d),
    delete: (id) => electron.ipcRenderer.invoke("proxies:delete", id),
    validate: (d) => electron.ipcRenderer.invoke("proxies:validate", d),
    assign: (pid, aid) => electron.ipcRenderer.invoke("proxies:assign", pid, aid)
  },
  settings: {
    get: () => electron.ipcRenderer.invoke("settings:get"),
    set: (k, v) => electron.ipcRenderer.invoke("settings:set", k, v)
  },
  drops: {
    getAll: () => electron.ipcRenderer.invoke("drops:getAll"),
    getByAccount: (id) => electron.ipcRenderer.invoke("drops:getByAccount", id),
    getStats: () => electron.ipcRenderer.invoke("drops:getStats")
  },
  window: {
    minimize: () => electron.ipcRenderer.send("window:minimize"),
    maximize: () => electron.ipcRenderer.send("window:maximize"),
    close: () => electron.ipcRenderer.send("window:close")
  },
  on: (ch, cb) => {
    const allowed = ["farm:status", "farm:drop", "farm:log"];
    if (allowed.includes(ch)) electron.ipcRenderer.on(ch, (_, ...a) => cb(...a));
  },
  off: (ch) => electron.ipcRenderer.removeAllListeners(ch)
});
