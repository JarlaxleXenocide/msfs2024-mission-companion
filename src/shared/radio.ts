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
  kind: 'acknowledge' | 'acknowledge-instruction' | 'acknowledge-approach' | 'acknowledge-pattern-entry'
    | 'acknowledge-landing' | 'acknowledge-ground-handoff' | 'acknowledge-taxi'
    | 'tune' | 'contact' | 'request-taxi-parking';
  option: RadioOption;
  key: string;
}
export interface RadioState {
  enabled: boolean;
  status: 'off' | 'connecting' | 'listening' | 'waiting' | 'acting' | 'paused';
  message: string;
  frequency: number | null;
  agent: string;
  latestMessage: string;
  lastAction: string;
}
