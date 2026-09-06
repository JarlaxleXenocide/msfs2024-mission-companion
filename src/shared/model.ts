export type Category = 'ILS' | 'LPV' | 'LNAV_VNAV' | 'LOC' | 'VOR';
export type Verdict = 'match' | 'no-match' | 'unknown';
export type Screen = 'browse' | 'inactive' | 'briefing' | 'unsupported';
export type ConnectionState =
  | 'connecting'
  | 'unavailable'
  | 'views-unavailable'
  | 'inactive'
  | 'briefing'
  | 'updating'
  | 'ready'
  | 'unsupported'
  | 'stalled';

export interface Mission {
  guid: string;
  title: string;
  activity: string;
  departure: string;
  destination: string;
  payoutText: string | null;
  payoutCredits: number | null;
  durationText: string | null;
}

export interface Icao {
  type: string;
  region: string;
  airport: string;
  ident: string;
}

export interface RunwayEnd {
  id: string;
  number: number;
  designator: number;
  physicalM: number | null;
  thresholdM: number | null;
  thresholdElevationM: number | null;
  physicalElevationM: number | null;
  closed: boolean | null;
  ilsMHz: number | null;
  glideslope: boolean | null;
}

export interface Procedure {
  name: string;
  type: number;
  rnavFlags: number | null;
  runwayNumber: number | null;
  runwayDesignator: number | null;
  rnpAr: boolean | null;
}

export interface AirportPosition { latitude: number; longitude: number }

export interface Airport {
  position: AirportPosition | null;
  key: string;
  ident: string;
  icao: Icao;
  ends: RunwayEnd[] | null;
  procedures: Procedure[] | null;
}

export interface Criteria {
  categories: Category[];
  minimumFt: number | null;
}

export interface Decision {
  verdict: Verdict;
  runwayIds: string[];
  reasons: string[];
}

export interface RunwayGroup {
  end: RunwayEnd | null;
  procedures: Procedure[];
}

export type AirportResult =
  | { status: 'ready'; airport: Airport }
  | { status: 'pending' }
  | { status: 'unknown'; reason: string };

export interface Capture {
  screen: Screen;
  observedAt: string;
  missions: Mission[];
}

export interface Row {
  mission: Mission;
  facility: AirportResult;
  decision: Decision | null;
}

export interface DesktopCapabilities {
  backend: 'wayland' | 'x11' | 'native';
  keepOnTop: 'supported' | 'desktop-managed';
  keepOnTopHelp: string | null;
  minimizePolling: 'supported' | 'desktop-limited';
  preferenceWarning: string | null;
}

export type RouteEndpoint =
  | { ident: string; status: 'pending' }
  | { ident: string; status: 'ready'; position: AirportPosition }
  | { ident: string; status: 'unavailable'; reason: string };

export interface RouteLookup {
  session: string;
  mission: Mission;
  departure: RouteEndpoint;
  destination: RouteEndpoint;
}

export interface AppState {
  route?: RouteLookup | null;
  desktop?: DesktopCapabilities;
  session: string | null;
  revision: number;
  observedAt: string | null;
  connection: ConnectionState;
  stale: boolean;
  message: string;
  rows: Row[];
}

export interface Preferences {
  port: number;
  criteria: Criteria;
  matchesOnly: boolean;
  compact: boolean;
  theme: 'deck' | 'notes' | 'clear';
  appearance: 'light' | 'night' | 'system';
  keepOnTop: boolean;
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface CompanionAPI {
  getState(): Promise<AppState>;
  getPreferences(): Promise<Preferences>;
  setPreferences(value: Preferences): Promise<Preferences>;
  refresh(): Promise<void>;
  refreshAirports(): Promise<void>;
  retry(): Promise<void>;
  openAttribution(key: 'osm' | 'leaflet'): Promise<void>;
  selectRoute(missionGuid: string | null): Promise<void>;
  subscribe(listener: (state: AppState) => void): () => void;
}

// The isolated renderer receives only this typed, serializable bridge.
declare global {
  interface Window { companion: CompanionAPI }
}
