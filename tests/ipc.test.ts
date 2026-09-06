import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { channels, parseCommand, defaultPreferences } from '../src/shared/validate';
import { registerCompanionIPC } from '../src/main/ipc';
import type { AppState } from '../src/shared/model';

const state: AppState = { session: null, revision: 0, observedAt: null, connection: 'unavailable', stale: true, message: 'Offline', rows: [] };

test('exact eight commands reject unknown names and unexpected payloads', () => {
  assert.equal(channels.length, 8);
  assert.throws(() => parseCommand('companion:evaluate', []));
  for (const channel of channels) {
    if (channel === 'companion:set-preferences') {
      assert.throws(() => parseCommand(channel, []));
      assert.throws(() => parseCommand(channel, [defaultPreferences, null]));
      for (const value of [null, { ...defaultPreferences, port: '19999' }, { ...defaultPreferences, criteria: { categories: ['ILS'], minimumFt: null, code: 'x' } }, { ...defaultPreferences, shell: 'x' }]) {
        assert.throws(() => parseCommand(channel, [value]));
      }
    } else {
      assert.throws(() => parseCommand(channel, [undefined]));
      assert.throws(() => parseCommand(channel, [{ code: 'x' }]));
    }
  }
});

test('registered handlers check sender identity, main frame and explicit dev/packaged URL before dispatch', async () => {
  for (const url of ['http://localhost:3000/main_window/index.html', 'file:///opt/MSFS Career Approach Companion/resources/app.asar/.webpack/renderer/main_window/index.html']) {
    const handlers = new Map<string, (event: any, ...args: unknown[]) => unknown>();
    const frame = { url: new URL(url).href };
    const sender = { mainFrame: frame };
    const event = { sender, senderFrame: frame };
    const calls: string[] = [];
    const dispose = registerCompanionIPC({ handle: (name, fn) => { handlers.set(name, fn); }, removeHandler: name => { handlers.delete(name); } }, sender, url, {
      selectRoute: value => { calls.push(`route:${value}`); },
      openAttribution: async value => { calls.push(`link:${value}`); },
      getState: () => state, getPreferences: () => defaultPreferences,
      setPreferences: async value => { calls.push('set'); return value; },
      refresh: async () => { calls.push('refresh'); }, refreshAirports: async () => { calls.push('airports'); }, retry: async () => { calls.push('retry'); },
    });
    assert.deepEqual([...handlers.keys()], [...channels]);
    for (const [name, fn] of handlers) {
      const args = name === 'companion:set-preferences' ? [defaultPreferences] : name === 'companion:select-route' ? [null] : name === 'companion:open-attribution' ? ['osm'] : [];
      for (const bad of [{ sender: { mainFrame: frame }, senderFrame: frame }, { sender, senderFrame: { url } }, { sender, senderFrame: null }]) {
        await assert.rejects(async () => fn(bad, ...args), /sender/);
      }
      frame.url = 'https://evil.invalid/';
      await assert.rejects(async () => fn(event, ...args), /sender/);
      frame.url = url + '.evil';
      await assert.rejects(async () => fn(event, ...args), /sender/);
      frame.url = new URL(url).href;
      if (name === 'companion:set-preferences') await assert.rejects(async () => fn(event, { ...defaultPreferences, port: 0 }));
      await assert.rejects(async () => fn(event, ...args, 'extra'));
      await fn(event, ...args);
    }
    assert.deepEqual(calls, ['set', 'refresh', 'airports', 'retry', 'route:null', 'link:osm']);
    assert.equal(handlers.has('companion:fs'), false);
    dispose();
    assert.equal(handlers.size, 0);
  }
});

test('actual preload exposes only CompanionAPI, strips event and unsubscribes exact listener', async () => {
  let api: any;
  const calls: unknown[][] = [];
  const listeners = new Set<(event: unknown, value: AppState) => void>();
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { assert.equal(name, 'companion'); api = value; } },
    ipcRenderer: {
      invoke: async (...args: unknown[]) => { calls.push(args); return state; },
      on: (name: string, fn: (event: unknown, value: AppState) => void) => { assert.equal(name, 'companion:state'); listeners.add(fn); },
      removeListener: (name: string, fn: (event: unknown, value: AppState) => void) => { assert.equal(name, 'companion:state'); listeners.delete(fn); },
    },
  };
  runInNewContext(readFileSync(join(__dirname, '../src/preload.js'), 'utf8'), { exports: {}, require: (name: string) => { assert.equal(name, 'electron'); return electron; } });
  assert.deepEqual(Object.keys(api).sort(), ['getState', 'getPreferences', 'setPreferences', 'refresh', 'refreshAirports', 'retry', 'selectRoute', 'openAttribution', 'subscribe'].sort());
  await api.getState(); await api.getPreferences(); await api.setPreferences(defaultPreferences); await api.refresh(); await api.refreshAirports(); await api.retry(); await api.selectRoute(null); await api.openAttribution('osm');
  assert.deepEqual(calls.map(call => call[0]), [...channels]);
  const received: unknown[][] = [];
  const unsubscribe = api.subscribe((...args: unknown[]) => received.push(args));
  for (const listener of listeners) listener({ secret: 'electron event' }, state);
  assert.deepEqual(received, [[state]]);
  unsubscribe(); unsubscribe();
  assert.equal(listeners.size, 0);
});

// Execute the real compiled main entry with Electron boundaries replaced, never the simulator.
async function mainHarness(write: (path: string, value: unknown) => Promise<void> = async () => {},
  platform: { name?: string; env?: Record<string, string>; requestedBackend?: string; argv?: readonly string[] } = {}) {
  const { EventEmitter } = await import('node:events');
  const exited = Symbol('app exited');
  let relaunch: { args: string[] } | undefined;
  let backend = '';
  const appUserModelIds: string[] = [];
  const exitCodes: (number | undefined)[] = [];
  const order: string[] = [];
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, getVersion: () => '0.1.2',
    relaunch: (options: { args: string[] }) => { relaunch = options; },
    exit: (code?: number) => { exitCodes.push(code); throw exited; },
    disableHardwareAcceleration: () => { order.push('software-rendering'); },
    setAppUserModelId: (id: string) => { appUserModelIds.push(id); },
    whenReady: async () => { order.push('ready'); }, getPath: () => '/isolated-user-data', quit: () => { order.push('quit'); app.emit('before-quit', { preventDefault() {} }); },
    // Electron 44 infers Wayland before main runs, even without a CLI override.
    commandLine: { getSwitchValue: () => platform.requestedBackend ?? 'x11', appendSwitch: (_name: string, value: string) => { backend = value; } },
  });
  const handlers = new Map<string, (event: any, ...args: unknown[]) => any>();
  const windows: FakeWindow[] = [];
  const links: string[] = [];
  const hooks: Record<string, any> = {};
  const webRequest = Object.fromEntries(['onBeforeSendHeaders', 'onHeadersReceived'].map(name => [name, (...args: any[]) => { hooks[name] = args.at(-1); }]));
  class FakeWindow extends EventEmitter {
    closed = false;
    bounds = { x: 25, y: 35, width: 950, height: 650 };
    webContents = Object.assign(new EventEmitter(), {
      id: windows.length + 1, mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false,
      send: (channel: string, value: AppState) => { pushes.push({ channel, value }); },
      setWindowOpenHandler: (handler: () => unknown) => { openHandler = handler; },
      session: { webRequest, setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} },
    });
    constructor(public options: unknown) { super(); windows.push(this); this.on('closed', () => { this.closed = true; }); }
    getNormalBounds() { return this.bounds; }
    isDestroyed() { return this.closed; }
    isMinimized() { return false; }
    setAlwaysOnTop() { order.push('pin'); }
    loadURL() { order.push('load'); return Promise.resolve(); }
    static getAllWindows() { return windows.filter(window => !window.closed); }
  }
  let openHandler: () => unknown = () => {};
  const pushes: { channel: string; value: AppState }[] = [];
  const controllers: FakeController[] = [];
  class FakeController {
    values: any[] = [];
    listener?: (state: AppState) => void;
    constructor(...args: unknown[]) { controllers.push(this); order.push('construct'); }
    start() { order.push('start'); this.listener?.(state); }
    stop() { order.push('stop'); }
    subscribe(listener: (state: AppState) => void) { order.push('subscribe'); this.listener = listener; return () => { order.push('unsubscribe'); }; }
    getState() { return state; }
    setMinimized(value: boolean) { order.push(`minimized:${value}`); }
    setPreferences(value: unknown) { this.values.push(value); this.listener?.(state); }
    async refresh() {}
    async refreshAirports() {}
    async retry() {}
    selectRoute(value: string | null) { this.values.push(value); }
  }
  const modules: Record<string, unknown> = {
    electron: { shell: { openExternal: async (url: string) => { links.push(url); } }, app, BrowserWindow: FakeWindow, ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) }, screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } },
    './main/controller': { Controller: FakeController }, './simulator/adapter': { SimulatorAdapter: class {} },
    './main/preferences': { readPreferences: async () => { order.push('preferences:read'); return defaultPreferences; }, writePreferences: async (path: string, value: unknown) => { order.push('preferences:write'); return write(path, value); } },
    './main/map-policy': require('../src/main/map-policy'), './main/window': require('../src/main/window'), './main/ipc': require('../src/main/ipc'), './shared/validate': require('../src/shared/validate'),
  };
  const processContext = {
    platform: platform.name ?? 'linux', env: platform.env ?? { WAYLAND_DISPLAY: 'wayland-test', DISPLAY: ':0' },
    argv: platform.argv ?? ['companion', `--ozone-platform=${platform.requestedBackend ?? 'x11'}`],
    execPath: '/installed/app/career-companion.exe',
  };
  const updater = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const diagnosticWrites: string[] = [];
  const copiedLogs: string[] = [];
  const squirrelModule = { exports: {} };
  runInNewContext(readFileSync(join(__dirname, '../src/main/squirrel.js'), 'utf8'), {
    exports: squirrelModule.exports, process: processContext, console, Buffer,
    require: (name: string) => name === 'node:child_process'
      ? { spawn: (_file: string, args: string[]) => { order.push(`update:${args.join(' ')}`); return updater; } }
      : name === 'node:fs' ? {
        mkdtempSync: () => '/outside-install/diagnostics',
        appendFileSync: (_file: string, value: string) => { diagnosticWrites.push(value); },
        existsSync: (file: string) => file.endsWith('Squirrel-Deshortcut.log'),
        copyFileSync: (source: string, destination: string) => { copiedLogs.push(destination); },
      } : require(name),
  });
  modules['./main/squirrel'] = squirrelModule.exports;
  try { runInNewContext(readFileSync(join(__dirname, '../src/main.js'), 'utf8'), {
    exports: {}, require: (name: string) => modules[name] ?? require(name), console, URL,
    process: processContext,
    MAIN_WINDOW_WEBPACK_ENTRY: 'file:///app/index.html', MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: '/app/preload.js',
  }); } catch (error) { if (error !== exited) throw error; }
  await new Promise(resolve => setImmediate(resolve));
  return { app, windows, controllers, order, handlers, pushes, backend, openHandler, relaunch, appUserModelIds, hooks, links, updater, diagnosticWrites, copiedLogs, exitCodes };
}

for (const [event, shortcut] of [
  ['install', 'create'], ['updated', 'create'], ['uninstall', 'remove'], ['obsolete', null],
] as const) {
  test(`Squirrel ${event} owns quit timing and skips normal initialization`, async () => {
    const h = await mainHarness(undefined, {
      name: 'win32', argv: ['career-companion.exe', `--squirrel-${event}`, '0.1.3'],
    });
    assert.deepEqual(h.order, shortcut ? [`update:--${shortcut}Shortcut=career-companion.exe`] : ['quit']);
    assert.equal(h.windows.length, 0);
    assert.equal(h.controllers.length, 0);
    assert.equal(h.handlers.size, 0);
    assert.equal(h.pushes.length, 0);
    assert.deepEqual(h.appUserModelIds, []);
    if (shortcut) {
      h.updater.emit('close', 0);
      assert.deepEqual(h.order, [`update:--${shortcut}Shortcut=career-companion.exe`, 'quit']);
    }
  });
}

test('Squirrel updater failure is not reported as a successful quit', async () => {
  const h = await mainHarness(undefined, { name: 'win32', argv: ['career-companion.exe', '--squirrel-uninstall', '0.1.3'] });
  h.updater.stderr.emit('data', Buffer.from('Access denied'));
  assert.throws(() => h.updater.emit('close', 1, null));
  assert.match(h.diagnosticWrites.join(''), /Access denied/);
  assert.match(h.diagnosticWrites.join(''), /\"code\":1/);
  assert.deepEqual(h.copiedLogs, [join('/outside-install/diagnostics', 'Squirrel-Deshortcut.log')]);
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.order.includes('quit'), false);
});

test('Squirrel records spawn errors and signals, and caps subprocess output', async () => {
  const options = { name: 'win32', argv: ['career-companion.exe', '--squirrel-uninstall', '0.1.3'] };
  const failed = await mainHarness(undefined, options);
  assert.throws(() => failed.updater.emit('error', new Error('ENOENT')));
  assert.match(failed.diagnosticWrites.join(''), /ENOENT/);
  assert.doesNotThrow(() => failed.updater.emit('close', -2, null));
  const killed = await mainHarness(undefined, options);
  killed.updater.stdout.emit('data', Buffer.alloc(100000, 'x'));
  killed.updater.stderr.emit('data', Buffer.from('after limit'));
  const output = killed.diagnosticWrites.map(line => JSON.parse(line)).filter(record => record.stream);
  assert.equal(output.length, 1);
  assert.equal(Buffer.byteLength(output[0].text), 65536);
  assert.equal(output[0].truncated, true);
  assert.throws(() => killed.updater.emit('close', null, 'SIGTERM'));
  assert.match(killed.diagnosticWrites.join(''), /SIGTERM/);
});

test('normal Windows launch keeps native graphics defaults, app identity and IPC isolation', async () => {
  const h = await mainHarness(undefined, {
    name: 'win32',
    requestedBackend: 'wayland',
    argv: ['career-companion.exe'],
  });
  assert.equal(h.backend, '');
  assert.equal(h.relaunch, undefined);
  assert.equal(h.order.includes('software-rendering'), false);
  assert.equal(h.pushes.at(-1)!.value.desktop!.backend, 'native');
  assert.deepEqual(h.appUserModelIds, ['com.squirrel.msfsCareerApproachCompanion.career-companion']);
  const webPreferences = (h.windows[0].options as { webPreferences: Record<string, unknown> }).webPreferences;
  assert.equal(webPreferences.preload, '/app/preload.js');
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.nodeIntegration, false);
  h.windows[0].emit('closed');
});

test('main owns one controller, wires minimize/restore, denies navigation, and disposes on close', async () => {
  const h = await mainHarness();
  assert.equal(h.controllers.length, 1);
  assert.equal(h.backend, 'x11');
  assert.ok(h.order.indexOf('software-rendering') >= 0);
  assert.ok(h.order.indexOf('software-rendering') < h.order.indexOf('ready'));
  assert.ok(h.order.indexOf('subscribe') < h.order.indexOf('start'));
  const window = h.windows[0];
  window.emit('minimize'); window.emit('blur'); window.emit('restore');
  assert.deepEqual(h.order.filter(value => value.startsWith('minimized:')), ['minimized:false', 'minimized:true', 'minimized:false']);
  assert.equal(h.order.includes('pin'), true);
  assert.equal((h.openHandler() as { action: string }).action, 'deny');
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    let prevented = false;
    window.webContents.emit(name, { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, name);
  }
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  await h.handlers.get('companion:select-route')!(event, 'selected-guid');
  assert.equal(h.controllers[0].values.at(-1), 'selected-guid');
  const prefs = await h.handlers.get('companion:set-preferences')!(event, { ...defaultPreferences, theme: 'deck', port: 23456 });
  assert.equal(h.controllers.length, 1);
  assert.equal(h.controllers[0].values.at(-1).port, 23456);
  assert.equal(prefs.width, 950);
  assert.equal(prefs.x, 25);
  assert.equal(h.pushes.at(-1)!.value.desktop!.keepOnTop, 'supported');
  window.emit('closed');
  assert.equal(h.handlers.size, 0);
  assert.ok(h.order.includes('unsubscribe'));
  assert.ok(h.order.includes('stop'));
});

for (const [name, options, expected] of [
  ['both displays default to XWayland', {}, 'x11'],
  ['explicit Wayland overrides an X display', { requestedBackend: 'wayland' }, 'wayland'],
  ['split explicit Wayland switch is preserved', { requestedBackend: 'wayland', argv: ['companion', '--ozone-platform', 'wayland'] }, 'wayland'],
  ['explicit X11 is preserved', { requestedBackend: 'x11' }, 'x11'],
  ['Wayland-only display falls back to Wayland', { env: { WAYLAND_DISPLAY: 'wayland-test' }, argv: ['companion'], requestedBackend: 'wayland' }, 'wayland'],
  ['non-Linux keeps native routing', { name: 'win32', requestedBackend: 'wayland' }, 'native'],
] as const) {
  test(`main backend selection: ${name}`, async () => {
    const h = await mainHarness(undefined, options);
    const wayland = expected === 'wayland';
    assert.equal(h.backend, expected === 'native' ? '' : expected);
    assert.equal(h.pushes.at(-1)!.value.desktop!.backend, expected);
    assert.equal(h.pushes.at(-1)!.value.desktop!.minimizePolling, wayland ? 'desktop-limited' : 'supported');
    assert.equal(h.order.includes('pin'), !wayland);
    assert.equal('x' in h.controllers[0].values.at(-1), !wayland);
    h.windows[0].emit('closed');
  });
}

test('main retains runtime settings on write failure and pushes a recoverable preference warning', async () => {
  const h = await mainHarness(async () => { throw new Error('test disk failure'); });
  const window = h.windows[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const value = await h.handlers.get('companion:set-preferences')!(event, { ...defaultPreferences, appearance: 'night' });
  assert.equal(value.appearance, 'night');
  assert.match(h.pushes.at(-1)!.value.desktop!.preferenceWarning!, /could not be saved/i);
  assert.equal(h.controllers[0].values.at(-1).appearance, 'night');
  window.emit('closed');
});


test('main flushes final normal bounds before quit and stops publishing to a disposed renderer', async () => {
  let finish!: () => void;
  const saved: any[] = [];
  const h = await mainHarness(async (_path, value) => { saved.push(value); await new Promise<void>(resolve => { finish = resolve; }); });
  h.windows[0].bounds.width = 870;
  let quitEvents = 0;
  h.app.on('before-quit', () => { quitEvents++; });
  h.app.quit();
  assert.equal(quitEvents, 1);
  assert.equal(saved.at(-1).width, 870);
  assert.equal(h.handlers.size, 0);
  const pushedBeforeExit = h.pushes.length;
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitEvents, 2);
  assert.equal(h.pushes.length, pushedBeforeExit);
});

test('a successful subsequent preference write clears the recoverable warning', async () => {
  let attempts = 0;
  const h = await mainHarness(async () => { if (++attempts === 1) throw new Error('temporary disk failure'); });
  const event = { sender: h.windows[0].webContents, senderFrame: h.windows[0].webContents.mainFrame };
  const set = h.handlers.get('companion:set-preferences')!;
  await set(event, { ...defaultPreferences, theme: 'deck' });
  assert.ok(h.pushes.at(-1)!.value.desktop!.preferenceWarning);
  await set(event, { ...defaultPreferences, theme: 'notes' });
  assert.equal(h.pushes.at(-1)!.value.desktop!.preferenceWarning, null);
  h.windows[0].emit('closed');
});

test('packaged default relaunches with X11 before creating a window or simulator controller', async () => {
  const h = await mainHarness(undefined, { argv: ['companion', '--user-data-dir=/isolated'], requestedBackend: 'wayland' });
  assert.deepEqual(Array.from(h.relaunch?.args ?? []), ['--user-data-dir=/isolated', '--ozone-platform=x11']);
  assert.equal(h.windows.length, 0);
  assert.equal(h.controllers.length, 0);
});


test('attribution accepts only fixed keys', () => {
  for (const key of ['osm', 'leaflet']) assert.deepEqual(parseCommand('companion:open-attribution', [key]), { channel: 'companion:open-attribution', key });
  for (const key of ['https://leafletjs.com/', 'file:///tmp/x', 'constructor', '__proto__', '', null, {}, 'OSM']) assert.throws(() => parseCommand('companion:open-attribution', [key]));
});

test('native tile hooks identify only owned exact HTTPS tile images, reject HTTP errors and dispose', async () => {
  const h = await mainHarness();
  assert.equal(typeof h.hooks.onBeforeSendHeaders, 'function');
  const window = h.windows[0], wc = window.webContents;
  const original = { 'user-agent': 'Chromium', Referer: 'http://localhost:3000/', 'If-None-Match': 'tile-tag', Accept: 'image/png' };
  const request = { url: 'https://tile.openstreetmap.org/1/0/0.png', webContentsId: wc.id, resourceType: 'image', requestHeaders: original };
  const invoke = (name: string, details: any) => { let result: any; h.hooks[name](details, (value: any) => { result = value; }); return result; };
  const headers = invoke('onBeforeSendHeaders', request).requestHeaders;
  assert.match(headers['User-Agent'], /^MSFS-Career-Approach-Companion\/0\.1\.2 \(\+https:\/\/github\.com\/JarlaxleXenocide\/msfs2024-mission-companion\)$/);
  assert.equal(headers['user-agent'], undefined);
  assert.equal(headers.Referer, original.Referer); assert.equal(headers['If-None-Match'], 'tile-tag'); assert.equal(headers.Accept, original.Accept);
  assert.equal(original['user-agent'], 'Chromium');
  const nativeHeaders = invoke('onBeforeSendHeaders', { ...request, requestHeaders: {} }).requestHeaders;
  assert.deepEqual(Object.keys(nativeHeaders), ['User-Agent']);
  for (const patch of [
    { webContentsId: wc.id + 1 }, { resourceType: 'xhr' },
    ...['http://tile.openstreetmap.org/1.png', 'https://tile.openstreetmap.org:444/1.png', 'https://tile.openstreetmap.org.evil.invalid/1.png', 'https://evil.invalid/1.png', 'http://127.0.0.1:19999/pagelist.json', 'ws://127.0.0.1:19999/', 'https://user@tile.openstreetmap.org/1.png'].map(url => ({ url })),
  ]) {
    assert.deepEqual(invoke('onBeforeSendHeaders', { ...request, ...patch }), {});
    assert.deepEqual(invoke('onHeadersReceived', { ...request, ...patch, statusCode: 500 }), {});
  }
  for (const statusCode of [200, 204, 301, 304]) assert.deepEqual(invoke('onHeadersReceived', { ...request, statusCode }), {});
  for (const statusCode of [400, 403, 404, 429, 500]) assert.deepEqual(invoke('onHeadersReceived', { ...request, statusCode }), { cancel: true });
  const event = { sender: wc, senderFrame: wc.mainFrame };
  await h.handlers.get('companion:open-attribution')!(event, 'osm');
  await h.handlers.get('companion:open-attribution')!(event, 'leaflet');
  assert.deepEqual(h.links, ['https://www.openstreetmap.org/copyright', 'https://leafletjs.com/']);
  window.emit('closed');
  assert.equal(h.hooks.onBeforeSendHeaders, null); assert.equal(h.hooks.onHeadersReceived, null);
  h.app.emit('activate');
  const recreated = h.windows[1];
  assert.deepEqual(invoke('onBeforeSendHeaders', request), {}, 'old window loses ownership');
  assert.equal(invoke('onBeforeSendHeaders', { ...request, webContentsId: recreated.webContents.id }).requestHeaders['User-Agent'], headers['User-Agent']);
  recreated.emit('closed');
  assert.equal(h.hooks.onBeforeSendHeaders, null); assert.equal(h.hooks.onHeadersReceived, null);
});
