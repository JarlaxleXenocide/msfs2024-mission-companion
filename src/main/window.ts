import type { BrowserWindow } from 'electron';
import type { DesktopCapabilities, Preferences } from '../shared/model';

interface Bounds { x: number; y: number; width: number; height: number }
export type WindowBackend = 'wayland' | 'x11' | 'native';

export function desktopCapabilities(backend: WindowBackend): DesktopCapabilities {
  return {
    backend,
    keepOnTop: backend === 'wayland' ? 'desktop-managed' : 'supported',
    keepOnTopHelp: backend === 'wayland'
      ? 'Use the KWin window menu (Alt+F3), More Actions → Keep above. Placement is managed by your desktop.' : null,
    minimizePolling: backend === 'wayland' ? 'desktop-limited' : 'supported',
    preferenceWarning: null,
  };
}

export function restoreBounds(preferences: Preferences, displays: Bounds[], wayland: boolean): { width: number; height: number; x?: number; y?: number } {
  const display = (wayland ? undefined : displays.find(display => preferences.x !== undefined && preferences.y !== undefined &&
    preferences.x >= display.x && preferences.x < display.x + display.width &&
    preferences.y >= display.y && preferences.y < display.y + display.height)) ?? displays[0];
  const width = Math.min(preferences.width, display?.width ?? preferences.width);
  const height = Math.min(preferences.height, display?.height ?? preferences.height);
  if (wayland || !display || preferences.x === undefined || preferences.y === undefined) return { width, height };
  return {
    width, height,
    x: Math.max(display.x, Math.min(preferences.x, display.x + display.width - width)),
    y: Math.max(display.y, Math.min(preferences.y, display.y + display.height - height)),
  };
}

export function withWindowBounds(preferences: Preferences, bounds: Bounds, wayland: boolean): Preferences {
  const { x: _x, y: _y, ...settings } = preferences;
  return { ...settings, width: bounds.width, height: bounds.height, ...(wayland ? {} : { x: bounds.x, y: bounds.y }) };
}

export function applyWindowPreferences(window: Pick<BrowserWindow, 'setAlwaysOnTop'>, preferences: Preferences, wayland: boolean): void {
  if (!wayland) window.setAlwaysOnTop(preferences.keepOnTop);
}
