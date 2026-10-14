/**
 * foolscap: the Electron main process.
 *
 * foolscap lives in the tray. One click on the icon opens a compact
 * panel anchored to it: what needs you, what your agents are doing, and
 * a line to start the next task. Everything else (diffs, history, the
 * terminal) opens in the full window, on demand.
 *
 * This process owns every agent session (server/fleet.mjs), the
 * permission relay Claude Code asks through (relay.mjs), the OS
 * notifications (notify.mjs) and the tray icon (tray-icon.mjs). The
 * pages talk to it over IPC only; the relay is the single loopback
 * HTTP listener, guarded by a per-run token.
 */
import { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rank } from "../../server/attention.mjs";
import { ExternalSessions } from "../../server/external.mjs";
import { Fleet, fleetAgentCatalog } from "../../server/fleet.mjs";
import * as claudeHooks from "./claude-hooks.mjs";
import { startHookServer } from "./hook-server.mjs";
import { Licence } from "./licence.mjs";
import { createNotifier } from "./notify.mjs";
import { startRelay } from "./relay.mjs";
import { Settings } from "./settings.mjs";
import { trayPixels } from "./tray-icon.mjs";

const APP_ID = "dev.foolscap.app";
// Windows routes notification button clicks to the app through this COM id.
const TOAST_CLSID = "{6B1F6E2C-5C5B-4C1D-9E0B-2B7F3D9A4C11}";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PRELOAD = join(HERE, "..", "preload.cjs");
const PANEL_WIDTH = 392;
const TOKEN = randomBytes(24).toString("hex");
const DEV_URL = process.env.VITE_DEV_SERVER_URL || null;

let settings;
let licence;
let fleet;
let external;
let hookServer = null;
let hookError = null;
let tray = null;
let panel = null;
let full = null;
let quitting = false;
let agents = [];
let taskbarDark = true;
const seen = new Set(); // "<id>:<turns>" the person has looked at

const log = (line) => console.log(`[foolscap] ${line}`);

// ── State ────────────────────────────────────────────────────────────

function snapshot() {
  const sessions = rank([...fleet.list(), ...external.list()], seen);
  const needs = sessions.filter((s) => s.attention.tier <= 1).length;
  const working = sessions.filter((s) => ["starting", "working", "checking", "blocked"].includes(s.status) && s.attention.tier > 1).length;
  return {
    sessions,
    agents,
    // The hook token stays in this process.
    settings: { ...settings.get(), hookToken: undefined },
    licence: licence.status(),
    hooks: { on: Boolean(settings.get().terminalSessions), error: hookError },
    counts: { needs, working },
    platform: process.platform,
  };
}

let pushTimer = null;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const state = snapshot();
    for (const win of [panel, full]) {
      if (win && !win.isDestroyed()) win.webContents.send("state", state);
    }
    updateTray(state);
  }, 40);
}

// ── Tray ─────────────────────────────────────────────────────────────

function trayState(state) {
  if (!settings.get().notify) return "paused";
  const urgent = state.sessions.filter((s) => s.attention.tier === 0);
  if (urgent.some((s) => s.verified?.verdict === "red" || s.held || s.status === "error")) return "red";
  if (state.counts.needs > 0) return "needs";
  if (state.counts.working > 0) return "working";
  return "quiet";
}

function trayImage(kind) {
  const buffer = trayPixels(kind, { size: 32, dark: taskbarDark });
  return nativeImage.createFromBitmap(buffer, { width: 32, height: 32, scaleFactor: 2 });
}

let lastTrayKind = null;
function updateTray(state = snapshot()) {
  if (!tray) return;
  const kind = trayState(state);
  if (kind !== lastTrayKind) {
    tray.setImage(trayImage(kind));
    lastTrayKind = kind;
  }
  const parts = [`${state.counts.needs} need you`, `${state.counts.working} working`];
  tray.setToolTip(`foolscap · ${parts.join(" · ")}`);
}

/** Windows' taskbar follows its own light/dark setting, separate from apps. */
function readTaskbarTheme() {
  if (process.platform !== "win32") {
    taskbarDark = nativeTheme.shouldUseDarkColors;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "SystemUsesLightTheme"],
      { windowsHide: true },
      (err, stdout) => {
        if (!err) taskbarDark = !/0x1\b/.test(String(stdout));
        resolve();
      },
    );
  });
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Open foolscap", click: () => showPanel() },
    { label: "Full view", accelerator: settings.get().shortcut, click: () => showFull() },
    { type: "separator" },
    {
      label: "Pause notifications",
      type: "checkbox",
      checked: !settings.get().notify,
      click: (item) => settings.set({ notify: !item.checked }).then(pushState),
    },
    { type: "separator" },
    { label: "Quit foolscap", click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(trayImage("quiet"));
  tray.setToolTip("foolscap");
  tray.on("click", () => togglePanel());
  tray.on("right-click", () => tray.popUpContextMenu(trayMenu()));
  // Many Linux trays only ever show a menu, so the menu opens the panel too.
  if (process.platform === "linux") tray.setContextMenu(trayMenu());
}

// ── Windows ──────────────────────────────────────────────────────────

function loadView(win, view) {
  if (DEV_URL) return win.loadURL(`${DEV_URL}?view=${view}`);
  return win.loadFile(join(ROOT, "dist", "renderer", "index.html"), { query: { view } });
}

const background = () => (nativeTheme.shouldUseDarkColors ? "#181B1E" : "#FFFFFF");

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    backgroundColor: background(),
    title: "foolscap",
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  panel.on("blur", () => {
    if (!panel.webContents.isDevToolsOpened()) panel.hide();
  });
  loadView(panel, "panel");
}

/** Anchor the panel to the tray icon, inside the work area, whatever edge the taskbar is on. */
function placePanel() {
  const bounds = tray?.getBounds();
  const point = bounds?.width
    ? { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
    : screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  const [w, h] = panel.getSize();
  const gap = 8;
  let x = point.x - Math.round(w / 2);
  let y = point.y - Math.round(h / 2);
  if (point.y >= area.y + area.height) y = area.y + area.height - h - gap;
  else if (point.y <= area.y) y = area.y + gap;
  if (point.x >= area.x + area.width) x = area.x + area.width - w - gap;
  else if (point.x <= area.x) x = area.x + gap;
  x = Math.min(Math.max(x, area.x + gap), area.x + area.width - w - gap);
  y = Math.min(Math.max(y, area.y + gap), area.y + area.height - h - gap);
  panel.setPosition(x, y);
}

function showPanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  placePanel();
  panel.show();
  panel.focus();
  pushState();
}

function togglePanel() {
  if (panel?.isVisible()) panel.hide();
  else showPanel();
}

function showFull(focusId = null) {
  if (!full || full.isDestroyed()) {
    full = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: "foolscap",
      backgroundColor: background(),
      autoHideMenuBar: true,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    if (process.platform === "win32") full.setBackgroundMaterial?.("mica");
    // Closing the window returns to the tray; Quit is in the tray menu.
    full.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        full.hide();
      }
    });
    loadView(full, "full");
    full.once("ready-to-show", () => full.show());
  } else {
    full.show();
    full.focus();
  }
  if (focusId) full.webContents.send("focus", focusId);
  panel?.hide();
  pushState();
}

function openSession(id) {
  if (panel?.isVisible() || !full?.isVisible()) showPanel();
  for (const win of [panel, full]) {
    if (win && !win.isDestroyed()) win.webContents.send("focus", id);
  }
}

// ── Sessions from the person's own terminal ──────────────────────────

function closeTask(id) {
  if (external.get(id)) external.get(id).close();
  else fleet.close(id);
}

const hookUrlNow = () => claudeHooks.hookUrl(settings.get().hookPort, settings.get().hookToken);

/** Listen for Claude Code's hooks while the person has them switched on. */
async function syncHookServer() {
  const want = settings.get().terminalSessions && settings.get().hookToken;
  if (!want && hookServer) {
    hookServer.close();
    hookServer = null;
  }
  if (want && !hookServer) {
    try {
      hookServer = await startHookServer({ port: settings.get().hookPort, token: settings.get().hookToken, external, log });
      hookError = null;
    } catch (err) {
      hookError = `port ${settings.get().hookPort} is busy (${err.code ?? err.message})`;
      log(`hook server: ${hookError}`);
    }
  }
  pushState();
}

// ── IPC ──────────────────────────────────────────────────────────────

function session(id) {
  const s = fleet.get(id) ?? external.get(id);
  if (!s) throw new Error("that task is gone");
  return s;
}

/** Each handler answers { ok, ...result } or { error } so the page can say why. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const result = await fn(...args);
      pushState();
      return { ok: true, ...(result ?? {}) };
    } catch (err) {
      return { error: String(err?.message ?? err) };
    }
  });
}

function applySettings() {
  const s = settings.get();
  fleet.defaults.settingSources = s.useMySettings ? null : "project,local";
  fleet.defaults.codexModel = s.codexModel || null;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: Boolean(s.openAtLogin) });
  globalShortcut.unregisterAll();
  if (s.shortcut) {
    try {
      globalShortcut.register(s.shortcut, () => togglePanel());
    } catch (err) {
      log(`shortcut ${s.shortcut} not available: ${err.message}`);
    }
  }
}

function registerIpc() {
  ipcMain.handle("state:get", () => snapshot());
  handle("task:start", async ({ agent, cwd, prompt, queue = [], worktree = true }) => {
    if (!cwd || !existsSync(cwd)) throw new Error("pick a folder that exists");
    if (!String(prompt ?? "").trim()) throw new Error("say what the agent should do");
    // Tasks already running always finish; only new ones wait for a key.
    if (!licence.allowed()) throw new Error("Your 14-day trial has ended. Get foolscap, or enter your key, to start new tasks.");
    await settings.addRepo(cwd);
    return { session: await fleet.launchTask({ agent, cwd, prompt: prompt.trim(), queue, worktree }) };
  });
  handle("task:answer", (id, optionId, text) => session(id).answerPermission(optionId, text));
  handle("task:prompt", (id, text) => {
    const s = session(id);
    if (s.status === "idle" || s.status === "done") s.prompt(String(text ?? "").trim());
    else s.enqueue(text);
  });
  handle("task:enqueue", (id, text) => session(id).enqueue(text));
  handle("task:dequeue", (id, index) => session(id).dequeue(index));
  handle("task:sendNext", (id) => session(id).sendNext());
  handle("task:cancel", (id) => session(id).cancel());
  handle("task:close", (id) => closeTask(id));
  handle("task:seen", (id, turns) => {
    seen.add(`${id}:${turns}`);
  });
  handle("task:openFolder", (id) => shell.openPath(session(id).cwd));
  handle("task:merge", async (id) => {
    const sha = await session(id).merge();
    fleet.close(id);
    return { sha };
  });
  handle("task:discard", async (id) => {
    await session(id).discard();
    fleet.close(id);
  });
  handle("repo:pick", async () => {
    const pick = await dialog.showOpenDialog(panel?.isVisible() ? panel : full, { properties: ["openDirectory"] });
    if (pick.canceled || !pick.filePaths[0]) return { picked: null };
    await settings.addRepo(pick.filePaths[0]);
    return { picked: pick.filePaths[0] };
  });
  handle("settings:set", async (input = {}) => {
    // Hooks are switched only through hooks:enable / hooks:disable, after the person has seen the plan.
    const { hookToken, hookPort, terminalSessions, ...patch } = input;
    await settings.set(patch);
    applySettings();
  });
  handle("agents:refresh", () => {
    agents = fleetAgentCatalog();
  });
  handle("hooks:plan", async () => {
    if (!settings.get().hookToken) await settings.set({ hookToken: randomBytes(18).toString("hex") });
    return { plan: claudeHooks.plan(hookUrlNow()) };
  });
  handle("hooks:enable", async () => {
    if (!settings.get().hookToken) await settings.set({ hookToken: randomBytes(18).toString("hex") });
    await claudeHooks.install(hookUrlNow());
    await settings.set({ terminalSessions: true });
    await syncHookServer();
  });
  handle("hooks:disable", async () => {
    await claudeHooks.uninstall();
    await settings.set({ terminalSessions: false });
    await syncHookServer();
  });
  handle("licence:activate", async (key) => ({ licence: await licence.activate(key) }));
  handle("licence:deactivate", async () => ({ licence: await licence.deactivate() }));
  handle("licence:refresh", async () => ({ licence: await licence.validate({ force: true }) }));
  // Only the purchase and portal links from polar.json open, and only over https.
  handle("licence:open", (which) => {
    const url = licence.status().links?.[which];
    if (!url || !url.startsWith("https://")) throw new Error("that link is not set up yet");
    return shell.openExternal(url);
  });
  ipcMain.on("panel:height", (_event, height) => {
    if (!panel || panel.isDestroyed()) return;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const h = Math.max(240, Math.min(Math.round(height), area.height - 16));
    const [, current] = panel.getContentSize();
    if (Math.abs(current - h) < 2) return;
    panel.setContentSize(PANEL_WIDTH, h);
    if (panel.isVisible()) placePanel();
  });
  ipcMain.on("view:full", (_event, focusId) => showFull(focusId ?? null));
  ipcMain.on("view:hidePanel", () => panel?.hide());
  ipcMain.on("app:quit", () => app.quit());
}

// ── Windows notifications in development ─────────────────────────────

/** Notification buttons need a Start-menu shortcut with our AppUserModelID.
    The installer makes the real one; a development run makes its own. */
function ensureDevShortcut() {
  if (process.platform !== "win32" || app.isPackaged) return;
  const lnk = join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "foolscap (dev).lnk");
  shell.writeShortcutLink(lnk, existsSync(lnk) ? "update" : "create", {
    target: process.execPath,
    args: `"${ROOT}"`,
    appUserModelId: APP_ID,
    toastActivatorClsid: TOAST_CLSID,
    description: "foolscap (development build)",
  });
}

// ── App ──────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.on("second-instance", () => showPanel());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await mkdir(app.getPath("userData"), { recursive: true });
    settings = new Settings(join(app.getPath("userData"), "settings.json"));
    await settings.load();

    const polar = JSON.parse(await readFile(join(HERE, "polar.json"), "utf8"));
    licence = new Licence({ file: join(app.getPath("userData"), "licence.json"), config: polar, packaged: app.isPackaged });
    await licence.load();
    const recheck = () => licence.validate().then(pushState).catch((err) => log(`licence check: ${err.message}`));
    recheck();
    setInterval(recheck, 6 * 60 * 60 * 1000).unref();

    fleet = new Fleet({ log, defaults: { verify: true } });
    const relay = await startRelay(fleet, TOKEN);
    fleet.defaults.relay = { url: relay.url, token: TOKEN };
    agents = fleetAgentCatalog();

    external = new ExternalSessions({ log });
    const notify = createNotifier({
      find: (id) => fleet.get(id) ?? external.get(id),
      closeTask,
      getSettings: () => settings.get(),
      onOpen: openSession,
      log,
    });
    for (const source of [fleet, external]) {
      source.on("change", (s) => {
        notify(s);
        pushState();
      });
    }
    await syncHookServer();

    ensureDevShortcut();
    await readTaskbarTheme();
    nativeTheme.on("updated", () => readTaskbarTheme().then(() => {
      lastTrayKind = null;
      updateTray();
    }));

    registerIpc();
    applySettings();
    createTray();
    createPanel();
    updateTray();
    log(`ready · relay ${relay.url}`);
  });

  // A tray app keeps running with no windows open.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    globalShortcut.unregisterAll();
    fleet?.closeAll();
  });
}
