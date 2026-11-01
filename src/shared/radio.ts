export interface RadioOption { id: number; text: string; enabled: boolean }
export interface RadioMessage { index: number; outgoing: boolean; queued: boolean; text: string }
export interface RadioSnapshot {
  lifetime: number;
  count: number;
  frequency: number;
  agent: string;
  options: RadioOption[];
  messages: RadioMessage[];
  complete: boolean;
}
export interface RadioAction {
  kind: 'acknowledge' | 'acknowledge-instruction' | 'acknowledge-descent' | 'acknowledge-assigned-approach' | 'acknowledge-approach' | 'acknowledge-pattern-entry'
    | 'acknowledge-arrival' | 'tune' | 'contact';
  option: RadioOption;
  key: string;
}
export interface RadioShutdown { at: number; reason: string }
export interface RadioState {
  lastShutdown?: RadioShutdown;
  logPath?: string;
  logWarning?: string;
  enabled: boolean;
  status: 'off' | 'connecting' | 'listening' | 'waiting' | 'acting' | 'paused';
  message: string;
  frequency: number | null;
  agent: string;
  latestMessage: string;
  lastAction: string;
}
