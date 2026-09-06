import type { Session } from 'electron';

export const attributionURLs = {
  leaflet: 'https://leafletjs.com/',
  osm: 'https://www.openstreetmap.org/copyright',
} as const;

// The default session retains Chromium's HTTP cache. Never synthesize a Referer.
export function installMapPolicy(session: Session, webContentsId: number, version: string): () => void {
  const filter = { urls: ['https://tile.openstreetmap.org/*'] };
  const ownsTile = (details: { url: string; webContentsId?: number; resourceType: string }): boolean => {
    const url = new URL(details.url);
    return details.webContentsId === webContentsId && details.resourceType === 'image' &&
      url.origin === 'https://tile.openstreetmap.org' && !url.username && !url.password;
  };
  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (!ownsTile(details)) { callback({}); return; }
    const requestHeaders = { ...details.requestHeaders };
    for (const name of Object.keys(requestHeaders)) if (name.toLowerCase() === 'user-agent') delete requestHeaders[name];
    requestHeaders['User-Agent'] = `MSFS-Career-Approach-Companion/${version} (+https://github.com/JarlaxleXenocide/msfs2024-mission-companion)`;
    callback({ requestHeaders });
  });
  session.webRequest.onHeadersReceived(filter, (details, callback) => {
    // An HTTP error can contain a decodable PNG; cancel it so Leaflet emits tileerror.
    callback(ownsTile(details) && details.statusCode >= 400 ? { cancel: true } : {});
  });
  return () => {
    session.webRequest.onBeforeSendHeaders(null);
    session.webRequest.onHeadersReceived(null);
  };
}
