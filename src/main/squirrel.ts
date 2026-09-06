import type { App } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export function handleSquirrelStartup(app: Pick<App, 'quit' | 'exit'>): boolean {
  if (process.platform !== 'win32') return false;
  const event = process.argv[1];
  if (!['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete'].includes(event)) return false;
  if (event === '--squirrel-obsolete') { app.quit(); return true; }

  // Outside the installation: Squirrel deletes that directory after this hook exits.
  let directory: string | undefined;
  try { directory = mkdtempSync(join(tmpdir(), 'msfs-career-squirrel-')); }
  catch (error) { console.error('Cannot create Squirrel diagnostics', error); }
  const record = (value: object): void => {
    try { if (directory) appendFileSync(join(directory, 'lifecycle.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); }
    catch (error) { console.error('Cannot write Squirrel diagnostics', error); }
  };
  const uninstall = event === '--squirrel-uninstall';
  const root = resolve(process.execPath, '..', '..');
  const args = [`--${uninstall ? 'remove' : 'create'}Shortcut=${basename(process.execPath)}`];
  record({ event, phase: 'start' });
  let finished = false;
  const finish = (code: number | null, signal: string | null, error?: string): void => {
    if (finished) return;
    finished = true;
    record({ phase: 'close', code, signal, error: error ?? null });
    // Squirrel's own detailed log is otherwise erased by the parent uninstaller.
    if (directory) for (let index = 0; index < 10; index++) {
      const name = `Squirrel-${uninstall ? 'Deshortcut' : 'Shortcut'}${index ? '.' + index : ''}.log`;
      try { if (existsSync(join(root, name))) copyFileSync(join(root, name), join(directory, name)); }
      catch (failure) { record({ phase: 'copy-log-error', error: String(failure) }); }
    }
    if (code === 0 && !signal && !error) app.quit();
    else app.exit(code && code > 0 ? code : 1);
  };
  try {
    const child = spawn(join(root, 'Update.exe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let remaining = 64 * 1024;
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      stream?.on('data', (chunk: Buffer) => {
        if (remaining <= 0) return;
        const kept = chunk.subarray(0, remaining);
        remaining -= kept.length;
        record({ stream: name, text: kept.toString('utf8'), truncated: kept.length < chunk.length || remaining === 0 });
      });
    }
    child.once('error', error => finish(null, null, error.message));
    child.once('close', (code, signal) => finish(code, signal));
  } catch (error) { finish(null, null, String(error)); }
  return true;
}
