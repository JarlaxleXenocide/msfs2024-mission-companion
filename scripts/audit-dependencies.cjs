const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Accepted for v0.1.6: upstream has no patched releases for these build tools.
// Exact versions and advisories only; runtime dependencies are never excepted.
const exceptions = {
  braces: { version: '3.0.3', severity: 'high', url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm' },
  'sprintf-js': { version: '1.1.3', severity: 'moderate', url: 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c' },
};

function evaluateAudit(report, lock) {
  assert(report && !report.error && report.auditReportVersion === 2 &&
    report.vulnerabilities && typeof report.vulnerabilities === 'object' && !Array.isArray(report.vulnerabilities) &&
    report.metadata?.vulnerabilities?.total === Object.keys(report.vulnerabilities).length,
  'Incomplete or failed npm audit response');
  assert(lock?.packages, 'Missing audit lockfile metadata');
  const vulnerabilities = report.vulnerabilities;
  const checked = new Map();
  function accepted(name, visiting = new Set()) {
    if (checked.has(name)) return checked.get(name);
    if (visiting.has(name)) return false;
    const entry = vulnerabilities[name];
    if (!entry || !Array.isArray(entry.nodes) || !entry.nodes.length ||
      !entry.nodes.every(node => lock.packages[node]?.dev === true) ||
      !Array.isArray(entry.via) || !entry.via.length) return false;
    const path = new Set([...visiting, name]);
    const allowed = entry.via.every(cause => {
      if (typeof cause === 'string') return accepted(cause, path);
      const exception = Object.hasOwn(exceptions, name) ? exceptions[name] : null;
      return exception && cause?.dependency === name && cause.url === exception.url &&
        cause.severity === exception.severity && entry.nodes.every(node => lock.packages[node].version === exception.version);
    });
    checked.set(name, allowed);
    return allowed;
  }
  const result = { accepted: [], rejected: [] };
  for (const name of Object.keys(vulnerabilities)) result[accepted(name) ? 'accepted' : 'rejected'].push(name);
  return result;
}

function main() {
  assert(process.env.npm_execpath, 'Run this check with npm run audit');
  const audit = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--json', '--package-lock-only'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  assert.ifError(audit.error);
  assert(audit.status === 0 || audit.status === 1, `npm audit failed: ${audit.stderr}`);
  const result = evaluateAudit(JSON.parse(audit.stdout), require('../package-lock.json'));
  if (result.accepted.length) {
    console.log(`Accepted ${result.accepted.length} build-only dependency findings from these known advisories:`);
    for (const exception of Object.values(exceptions)) console.log(exception.url);
  }
  if (result.rejected.length) {
    console.error(`Unaccepted npm audit findings: ${result.rejected.join(', ')}`);
    process.exitCode = 1;
  } else console.log('Dependency audit passed: no unaccepted findings.');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { evaluateAudit };
