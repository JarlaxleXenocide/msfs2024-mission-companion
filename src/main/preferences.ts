import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Preferences } from '../shared/model';
import { defaultPreferences, parsePreferences } from '../shared/validate';

const writes = new Map<string, Promise<void>>();

export async function readPreferences(path: string, onWarning: (message: string) => void = () => {}): Promise<Preferences> {
  try {
    return parsePreferences(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      onWarning('Saved preferences could not be read. Defaults are in use; change a setting to save again.');
    }
    return parsePreferences(defaultPreferences);
  }
}

export async function writePreferences(path: string, preferences: Preferences): Promise<void> {
  // Capture/validate before queueing so callers cannot mutate a pending write.
  const json = JSON.stringify(parsePreferences(preferences), null, 2) + '\n';
  const previous = writes.get(path) ?? Promise.resolve();
  const writing = previous.catch(() => {}).then(async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, json, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
  writes.set(path, writing);
  try { await writing; }
  finally { if (writes.get(path) === writing) writes.delete(path); }
}
