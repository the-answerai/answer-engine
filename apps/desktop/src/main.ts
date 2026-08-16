import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  protocol,
  Tray,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerDesktopIpc, type DesktopIpcEnvironment } from './ipc.js';
import { rendererResponse } from './renderer-protocol.js';
import {
  FixtureRuntimeController,
  LocalRuntimeController,
  type DesktopController,
} from './runtime-controller.js';
import { secureWebPreferences, shouldQuitAfterLastWindowClosed } from './security.js';
import type { DesktopChannel } from './shared.js';
import { presentTrayStatus } from './tray.js';

protocol.registerSchemesAsPrivileged([{
  scheme: 'answer-engine',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = process.env.AE_DESKTOP_FIXTURE === '1';
const controller: DesktopController = fixture
  ? new FixtureRuntimeController()
  : new LocalRuntimeController();
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let selectedChannel: DesktopChannel = 'stable';
let quitting = false;
let fixtureLaunchAtLogin = false;

const fixtureIpcEnvironment: DesktopIpcEnvironment = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  getLaunchAtLogin: () => fixtureLaunchAtLogin,
  setLaunchAtLogin: (enabled) => { fixtureLaunchAtLogin = enabled; },
};

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'Answer Engine',
    width: 1040,
    height: 780,
    minWidth: 360,
    minHeight: 640,
    show: false,
    backgroundColor: '#f3efe5',
    webPreferences: secureWebPreferences(join(moduleDirectory, 'preload.cjs'), fixture),
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  void window.loadURL('answer-engine://desktop/index.html');
  return window;
}

async function refreshTray(): Promise<void> {
  if (!tray) return;
  try {
    const status = await controller.getStatus(selectedChannel);
    const presentation = presentTrayStatus(status);
    tray.setToolTip(presentation.tooltip);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: presentation.header, enabled: false },
      { type: 'separator' },
      { label: 'Open Answer Engine', click: showWindow },
      {
        label: 'Channel',
        submenu: (['stable', 'staging'] as const).map((channel) => ({
          label: channel === 'stable' ? 'Stable' : 'Staging',
          type: 'radio',
          checked: selectedChannel === channel,
          click: () => { selectedChannel = channel; void refreshTray(); },
        })),
      },
      {
        label: 'Repair selected channel',
        click: () => { void controller.run({ channel: selectedChannel, action: 'repair' }).then(refreshTray).catch(refreshTray); },
      },
      { type: 'separator' },
      { label: 'Quit launcher', click: () => { quitting = true; app.quit(); } },
    ]));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Status unavailable';
    tray.setToolTip(`Answer Engine ${selectedChannel} — status unavailable`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Status unavailable', enabled: false },
      { label: message.slice(0, 80), enabled: false },
      { type: 'separator' },
      { label: 'Open launcher to repair', click: showWindow },
      { label: 'Quit launcher', click: () => { quitting = true; app.quit(); } },
    ]));
  }
}

async function start(): Promise<void> {
  app.setName('Answer Engine');
  await app.whenReady();
  protocol.handle('answer-engine', (request) => rendererResponse(join(moduleDirectory, 'renderer'), request.url));
  registerDesktopIpc(controller, fixture ? fixtureIpcEnvironment : undefined);
  mainWindow = createWindow();
  const icon = nativeImage.createFromPath(join(moduleDirectory, 'assets', 'tray.svg'));
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.on('click', showWindow);
  await refreshTray();
  const timer = setInterval(() => { void refreshTray(); }, 15_000);
  timer.unref();
}

app.on('activate', showWindow);
app.on('window-all-closed', () => {
  if (shouldQuitAfterLastWindowClosed()) app.quit();
});
app.on('before-quit', () => { quitting = true; });

void start().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    level: 'error',
    component: 'desktop-launcher',
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  app.exit(1);
});
