const assert = require('node:assert/strict');
const semver = require('semver');

function validateTag(tag, version) {
  assert.equal(tag, `v${version}`, 'Tag must exactly match v + package.json version');
  assert(!/\s/.test(version), 'Package version must not contain whitespace');
  assert.equal(semver.valid(version), version.split('+')[0], 'Package version must be canonical SemVer');
  return semver.prerelease(version) !== null;
}

if (require.main === module) {
  const prerelease = validateTag(process.env.RELEASE_TAG, require('../package.json').version);
  console.log(`prerelease=${prerelease}`);
}
module.exports = { validateTag };
