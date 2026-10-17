const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAudit } = require('../scripts/audit-dependencies.cjs');

const advisory = (name, id, severity) => ({ name, dependency: name, url: `https://github.com/advisories/${id}`, severity });
function fixture() {
  const vulnerabilities = {
    braces: { nodes: ['node_modules/braces'], via: [advisory('braces', 'GHSA-vfj7-8cjw-p6xm', 'high')] },
    'sprintf-js': { nodes: ['node_modules/sprintf-js'], via: [advisory('sprintf-js', 'GHSA-hp3w-g68c-fv3c', 'moderate')] },
    tool: { nodes: ['node_modules/tool'], via: ['braces', 'sprintf-js'] },
  };
  const report = { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: 3 } } };
  const lock = { packages: {
    'node_modules/braces': { version: '3.0.3', dev: true },
    'node_modules/sprintf-js': { version: '1.1.3', dev: true },
    'node_modules/tool': { version: '1.0.0', dev: true },
  } };
  return { report, lock };
}

test('audit accepts only the approved build-only advisories and their dependent tooling', () => {
  const { report, lock } = fixture();
  assert.deepEqual(evaluateAudit(report, lock), { accepted: ['braces', 'sprintf-js', 'tool'], rejected: [] });
});

test('audit rejects new advisories even on an excepted package and rejects its dependents', () => {
  const { report, lock } = fixture();
  report.vulnerabilities.braces.via.push(advisory('braces', 'GHSA-new-finding', 'low'));
  assert.deepEqual(evaluateAudit(report, lock).rejected, ['braces', 'tool']);
});

test('audit exceptions cannot cover production dependencies, changed versions or increased severity', () => {
  for (const change of [
    ({ lock }) => { lock.packages['node_modules/braces'].dev = false; },
    ({ lock }) => { lock.packages['node_modules/braces'].version = '3.0.4'; },
    ({ report }) => { report.vulnerabilities.braces.via[0].severity = 'critical'; },
  ]) {
    const value = fixture(); change(value);
    assert.deepEqual(evaluateAudit(value.report, value.lock).rejected, ['braces', 'tool']);
  }
  const { report, lock } = fixture();
  lock.packages['node_modules/tool'].dev = false;
  assert.deepEqual(evaluateAudit(report, lock).rejected, ['tool']);
});

test('audit rejects missing or cyclic dependency causes and unknown installed nodes', () => {
  for (const change of [
    ({ report }) => { report.vulnerabilities.tool.via = ['missing']; },
    ({ report }) => { report.vulnerabilities.tool.via = ['tool']; },
    ({ report }) => { report.vulnerabilities.tool.via = []; },
    ({ lock }) => { delete lock.packages['node_modules/tool']; },
  ]) {
    const value = fixture(); change(value);
    assert.deepEqual(evaluateAudit(value.report, value.lock).rejected, ['tool']);
  }
});

test('audit accepts a clean report but fails closed on incomplete or failed audit responses', () => {
  assert.deepEqual(evaluateAudit({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }, { packages: {} }), { accepted: [], rejected: [] });
  for (const report of [{}, { error: { message: 'Registry unavailable' } }, { ...fixture().report, vulnerabilities: {} }]) {
    assert.throws(() => evaluateAudit(report, fixture().lock), /audit/i);
  }
});
