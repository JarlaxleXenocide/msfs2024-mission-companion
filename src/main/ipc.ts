import type { AppState, Preferences } from '../shared/model';
import { channels, parseCommand } from '../shared/validate';

interface Sender { mainFrame: { url: string } }
interface IPCEvent { sender: Sender; senderFrame: { url: string } | null }
interface IPCRegistry {
  handle(channel: string, listener: (event: IPCEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
interface Commands {
  getState(): AppState;
  getPreferences(): Preferences;
  setPreferences(value: Preferences): Promise<Preferences>;
  refresh(): Promise<void>;
  refreshAirports(): Promise<void>;
  retry(): Promise<void>;
  openAttribution(key: 'osm' | 'leaflet'): Promise<void>;
  selectRoute(missionGuid: string | null): void;
}

export function registerCompanionIPC(ipc: IPCRegistry, sender: Sender, rendererURL: string, commands: Commands): () => void {
  const trustedURL = new URL(rendererURL).href;
  // Full entry URL equality also pins file: origins to this packaged renderer.
  // Web origins alone would collapse every file: document to the same null origin.
  for (const channel of channels) {
    ipc.handle(channel, (event, ...args) => {
      if (event.sender !== sender || event.senderFrame !== sender.mainFrame || event.senderFrame.url !== trustedURL) {
        throw new Error('Unexpected IPC sender');
      }
      const command = parseCommand(channel, args);
      switch (command.channel) {
        case 'companion:get-state': return commands.getState();
        case 'companion:get-preferences': return commands.getPreferences();
        case 'companion:set-preferences': return commands.setPreferences(command.preferences);
        case 'companion:refresh': return commands.refresh();
        case 'companion:refresh-airports': return commands.refreshAirports();
        case 'companion:select-route': return commands.selectRoute(command.missionGuid);
        case 'companion:open-attribution': return commands.openAttribution(command.key);
        case 'companion:retry': return commands.retry();
      }
    });
  }
  return () => { for (const channel of channels) ipc.removeHandler(channel); };
}
