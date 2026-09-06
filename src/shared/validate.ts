import type { Preferences } from './model';

const categories = ['ILS', 'LPV', 'LNAV_VNAV', 'LOC', 'VOR'] as const;
const themes = ['deck', 'notes', 'clear'] as const;
const appearances = ['light', 'night', 'system'] as const;
const preferenceFields = new Set([
  'port',
  'criteria',
  'matchesOnly',
  'compact',
  'theme',
  'appearance',
  'keepOnTop',
  'width',
  'height',
  'x',
  'y',
]);
const criteriaFields = new Set(['categories', 'minimumFt']);

export const defaultPreferences: Preferences = {
  port: 19999,
  criteria: { categories: ['ILS'], minimumFt: null },
  matchesOnly: false,
  compact: false,
  theme: 'clear',
  appearance: 'system',
  keepOnTop: false,
  width: 1100,
  height: 760,
};

export function parsePreferences(input: unknown): Preferences {
  const value = expectObject(input, 'preferences');
  rejectUnknownFields(value, preferenceFields, 'preferences');

  const criteria = expectObject(value.criteria, 'criteria');
  rejectUnknownFields(criteria, criteriaFields, 'criteria');
  if (!Array.isArray(criteria.categories)) {
    throw new TypeError('criteria.categories must be an array');
  }

  const parsed: Preferences = {
    port: expectInteger(value.port, 'port', 1, 65535),
    criteria: {
      categories: criteria.categories.map((category) =>
        expectOneOf(category, categories, 'category'),
      ),
      minimumFt: expectMinimum(criteria.minimumFt),
    },
    matchesOnly: expectBoolean(value.matchesOnly, 'matchesOnly'),
    compact: expectBoolean(value.compact, 'compact'),
    theme: expectOneOf(value.theme, themes, 'theme'),
    appearance: expectOneOf(value.appearance, appearances, 'appearance'),
    keepOnTop: expectBoolean(value.keepOnTop, 'keepOnTop'),
    width: expectInteger(value.width, 'width', 1),
    height: expectInteger(value.height, 'height', 1),
  };

  if ('x' in value) parsed.x = expectInteger(value.x, 'x');
  if ('y' in value) parsed.y = expectInteger(value.y, 'y');
  return parsed;
}

function expectObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`unknown ${name} field: ${field}`);
  }
}

function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}

function expectInteger(
  value: unknown,
  name: string,
  minimum?: number,
  maximum?: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    (minimum !== undefined && value < minimum) ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new TypeError(`${name} must be a valid integer`);
  }
  return value;
}

function expectMinimum(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('minimumFt must be null or a nonnegative finite number');
  }
  return value;
}

function expectOneOf<const Values extends readonly string[]>(
  value: unknown,
  choices: Values,
  name: string,
): Values[number] {
  for (const choice of choices) {
    if (value === choice) return choice;
  }
  throw new TypeError(`${name} has an unsupported value`);
}

export const channels = ['companion:get-state', 'companion:get-preferences',
  'companion:set-preferences', 'companion:refresh', 'companion:refresh-airports',
  'companion:retry', 'companion:select-route', 'companion:open-attribution'] as const;

type Command = { channel: Exclude<typeof channels[number], 'companion:set-preferences' | 'companion:select-route' | 'companion:open-attribution'> }
  | { channel: 'companion:set-preferences'; preferences: Preferences }
  | { channel: 'companion:select-route'; missionGuid: string | null }
  | { channel: 'companion:open-attribution'; key: 'osm' | 'leaflet' };

export function parseCommand(channel: unknown, args: readonly unknown[]): Command {
  const name = expectOneOf(channel, channels, 'channel');
  if (name === 'companion:open-attribution') {
    if (args.length !== 1) throw new TypeError('open-attribution requires exactly one key');
    return { channel: name, key: expectOneOf(args[0], ['osm', 'leaflet'], 'attribution') };
  }
  if (name === 'companion:select-route') {
    if (args.length !== 1 || (args[0] !== null && (typeof args[0] !== 'string' || !args[0].trim()))) {
      throw new TypeError('select-route requires one nonempty mission GUID or null');
    }
    return { channel: name, missionGuid: args[0] as string | null };
  }
  if (name === 'companion:set-preferences') {
    if (args.length !== 1) throw new TypeError('set-preferences requires exactly one argument');
    return { channel: name, preferences: parsePreferences(args[0]) };
  }
  if (args.length !== 0) throw new TypeError('Command does not accept arguments');
  return { channel: name };
}
