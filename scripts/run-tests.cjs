const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

function discoverTestFiles(root = process.cwd()) {
  const compiled = resolve(root, '.test-build/tests');
  const source = resolve(root, 'tests');
  return [
    ...readdirSync(compiled)
      .filter(file => file.endsWith('.test.js'))
      .sort()
      .map(file => join(compiled, file)),
    ...readdirSync(source)
      .filter(file => file.endsWith('.test.cjs'))
      .sort()
      .map(file => join(source, file)),
  ];
}

if (require.main === module) {
  const result = spawnSync(process.execPath, ['--test', ...discoverTestFiles()], { stdio: 'inherit' });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}

module.exports = { discoverTestFiles };
