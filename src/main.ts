import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { join } from 'node:path';
import { attributionURLs, installMapPolicy } from './main/map-policy';
import { Controller } from './main/controller';
import { registerCompanionIPC } from './main/ipc';
import { readPreferences, writePreferences } from './main/preferences';
import { applyWindowPreferences, desktopCapabilities, restoreBounds, withWindowBounds, type WindowBackend } from './main/window';
import { SimulatorAdapter } from './simulator/adapter';
import { parsePreferences } from './shared/validate';
import type { Preferences } from './shared/model';

const squirrelStartup = require('electron-squirrel-startup') as boolean;

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Forge emits an unescaped file URL; Electron reports its canonical form (e.g. %20).
const rendererURL = new URL(MAIN_WINDOW_WEBPACK_ENTRY).href;

// Squirrel owns quitting after Update.exe finishes creating/removing shortcuts.
if (!squirrelStartup) startApplication();

function startApplication(): void {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.squirrel.msfsCareerApproachCompanion.career-companion');
  }

  // This table UI needs no GPU; avoid Mesa/GBM crashes without weakening the sandbox.
  if (process.platform === 'linux') app.disableHardwareAcceleration();

  // Prefer tested XWayland minimize support when an X display is available.
  // Electron may infer this switch itself; only actual CLI flags are user overrides.
  const requestedBackend = process.argv.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))
    ? app.commandLine.getSwitchValue('ozone-platform') : '';
  // Ozone is initialized before main: changing its switch here cannot change the
  // browser process backend. Restart the packaged default before any simulator work.
  if (app.isPackaged && process.platform === 'linux' && process.env.DISPLAY &&
      !requestedBackend && app.commandLine.getSwitchValue('ozone-platform') !== 'x11') {
    app.relaunch({ args: [...process.argv.slice(1), '--ozone-platform=x11'] });
    app.exit(0);
  }
  const backend: WindowBackend = process.platform !== 'linux' ? 'native'
    : requestedBackend === 'x11' || requestedBackend === 'wayland' ? requestedBackend
    : process.env.DISPLAY ? 'x11' : process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11';
  if (backend !== 'native') app.commandLine.appendSwitch('ozone-platform', backend);
  const desktop = desktopCapabilities(backend);
  const wayland = backend === 'wayland';
  let controller: Controller | undefined;
  let window: BrowserWindow | null = null;
  let preferences: Preferences;
  let preferencesPath: string;
  let disposeWindow: (() => void) | undefined;
  let quitting = false;
  let preferenceVersion = 0;
  const pendingWrites = new Set<Promise<void>>();

  function getState() {
    return { ...controller!.getState(), desktop: { ...desktop } };
  }

  function pushState(): void {
    if (!quitting && window && !window.isDestroyed() && !window.webContents.isDestroyed() &&
        window.webContents.mainFrame.url === rendererURL) {
      window.webContents.send('companion:state', getState());
    }
  }

  async function setPreferences(value: Preferences): Promise<Preferences> {
    preferences = parsePreferences(window && !window.isDestroyed()
      ? withWindowBounds(value, window.getNormalBounds(), wayland) : value);
    controller!.setPreferences(preferences);
    if (window) applyWindowPreferences(window, preferences, wayland);
    const version = ++preferenceVersion;
    const writing = writePreferences(preferencesPath, preferences).then(() => {
      if (version === preferenceVersion) desktop.preferenceWarning = null;
    }, () => {
      if (version === preferenceVersion) desktop.preferenceWarning = 'Preferences could not be saved. Your settings remain active for this session; change a setting to try again.';
    }).then(pushState);
    pendingWrites.add(writing);
    try { await writing; }
    finally { pendingWrites.delete(writing); }
    return parsePreferences(preferences);
  }

  function saveWindowBounds(): void {
    if (quitting || !window || window.isDestroyed() || window.isMinimized()) return;
    const next = withWindowBounds(preferences, window.getNormalBounds(), wayland);
    if (next.width !== preferences.width || next.height !== preferences.height || next.x !== preferences.x || next.y !== preferences.y) {
      void setPreferences(next);
    }
  }

  function createWindow(): void {
    const displays = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map(display => display.workArea);
    const bounds = restoreBounds(preferences, displays, wayland);
    const created = new BrowserWindow({
      ...bounds,
      webPreferences: {
        preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window = created;
    preferences = withWindowBounds(preferences, created.getNormalBounds(), wayland);
    controller!.setPreferences(preferences);
    applyWindowPreferences(created, preferences, wayland);

    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    created.webContents.on('will-navigate', event => event.preventDefault());
    created.webContents.on('will-frame-navigate', event => event.preventDefault());
    created.webContents.on('will-redirect', event => event.preventDefault());
    created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    created.webContents.session.setPermissionCheckHandler(() => false);
    created.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`Preload failed (${preloadPath}):`, error);
    });
    created.webContents.on('did-finish-load', pushState);

    const removeMapPolicy = installMapPolicy(created.webContents.session, created.webContents.id, app.getVersion());
    const removeIPC = registerCompanionIPC(ipcMain, created.webContents, rendererURL, {
      getState,
      openAttribution: key => shell.openExternal(attributionURLs[key]),
      getPreferences: () => parsePreferences(preferences),
      setPreferences,
      refresh: () => controller!.refresh(),
      selectRoute: missionGuid => controller!.selectRoute(missionGuid),
      refreshAirports: () => controller!.refreshAirports(),
      retry: () => controller!.retry(),
    });
    const unsubscribe = controller!.subscribe(pushState);
    disposeWindow = () => { unsubscribe(); removeIPC(); removeMapPolicy(); };
    created.on('minimize', () => controller!.setMinimized(true));
    created.on('restore', () => controller!.setMinimized(false));
    // Native Wayland/server decorations may not emit minimize; never infer it from blur.
    created.on('resize', saveWindowBounds);
    created.on('move', saveWindowBounds);
    created.on('close', saveWindowBounds);
    created.on('closed', () => {
      disposeWindow?.(); disposeWindow = undefined;
      controller!.stop();
      window = null;
    });
    controller!.setMinimized(false);
    controller!.start();
    void created.loadURL(rendererURL).catch(error => console.error('Renderer failed to load:', error));
  }

  void app.whenReady().then(async () => {
    preferencesPath = join(app.getPath('userData'), 'preferences.json');
    preferences = await readPreferences(preferencesPath, message => { desktop.preferenceWarning = message; });
    controller = new Controller(new SimulatorAdapter(preferences.port), preferences);
    createWindow();
    app.on('activate', () => {
      if (!quitting && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    saveWindowBounds();
    quitting = true;
    controller?.stop();
    disposeWindow?.(); disposeWindow = undefined;
    void Promise.all([...pendingWrites]).then(() => app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
