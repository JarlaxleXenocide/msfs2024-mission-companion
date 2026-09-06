const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { join } = require('node:path');

test('development launch adds X11 only with an X display and preserves Forge/app arguments', () => {
  const source = readFileSync(join(__dirname, '../scripts/start.cjs'), 'utf8');
  for (const [platform, env, args, expected] of [
    ['linux', { DISPLAY: ':0' }, ['--inspect-electron'], ['--inspect-electron', '--', '--ozone-platform=x11']],
    ['linux', { DISPLAY: ':0' }, ['--', '--disable-gpu'], ['--', '--disable-gpu', '--ozone-platform=x11']],
    ['linux', { DISPLAY: ':0' }, ['--', '--ozone-platform=wayland'], ['--', '--ozone-platform=wayland']],
    ['linux', { DISPLAY: ':0' }, ['--', '--ozone-platform', 'wayland'], ['--', '--ozone-platform', 'wayland']],
    ['linux', { WAYLAND_DISPLAY: 'wayland-0' }, [], []],
    ['win32', {}, [], []],
    ['win32', {}, ['--', '--disable-gpu'], ['--', '--disable-gpu']],
  ]) {
    const process = { platform, env, argv: ['node', 'start.cjs', ...args] };
    let launched = false;
    runInNewContext(source, { process, require: name => { assert.equal(name, '@electron-forge/cli/dist/electron-forge-start'); launched = true; } });
    assert.equal(launched, true);
    assert.deepEqual(process.argv.slice(2), expected);
  }
});
