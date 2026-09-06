const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function verifyLifecycle(directory) {
  const seen = new Set();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('msfs-career-squirrel-')) continue;
    const records = readFileSync(join(directory, entry.name, 'lifecycle.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const starts = records.filter(record => record.phase === 'start');
    const closes = records.filter(record => record.phase === 'close');
    assert.equal(starts.length, 1, `${entry.name}: missing or ambiguous hook start`);
    const event = starts[0].event;
    assert.equal(closes.length, 1, `${event}: incomplete hook; inspect ${entry.name}`);
    const close = closes[0];
    assert(close.code === 0 && !close.signal && !close.error, `${event} failed: ${JSON.stringify(close)}; inspect ${entry.name}`);
    seen.add(event);
  }
  for (const event of ['--squirrel-install', '--squirrel-uninstall']) {
    assert(seen.has(event), `Missing ${event} diagnostics; inspect Electron startup log`);
  }
}

if (require.main === module) {
  verifyLifecycle(process.argv[2]);
  console.log('Squirrel install and uninstall hooks completed successfully');
}
module.exports = { verifyLifecycle };
