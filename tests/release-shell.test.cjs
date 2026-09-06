const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const bash = process.env.RELEASE_SHELL_BASH || '/bin/bash';
const shellPath = (path) => process.platform === 'win32' ? path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : path;

test('release shell guards creation and preserves downloadable checksum filenames', { skip: process.platform !== 'linux' && !process.env.RELEASE_SHELL_BASH }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-release-guard-'));
  try {
    // Execute the actual final release run block; actionlint validates its YAML separately.
    const workflow = readFileSync(join(__dirname, '../.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
    const script = workflow.split('        run: |\n').at(-1).replace(/^          /gm, '');
    writeFileSync(join(dir, 'gh'), `#!/bin/bash
set -euo pipefail
if [[ "$1" == api && "$2" == --paginate ]]; then
  [[ "$3" == 'repos/example/repo/releases?per_page=100' && "$4" == --jq && "$5" == '.[].tag_name' ]] || exit 91
  case "$TEST_CASE" in
    draft|published) printf '%s\\n' v0.0.1 v0.1.0 ;;
    api-error) echo 'authentication failure' >&2; exit 17 ;;
    partial-error) printf '%s\\n' v0.0.1; echo 'page two failed' >&2; exit 18 ;;
    *) printf '%s\\n' v0.1.00 ;;
  esac
elif [[ "$1" == api && "$2" == "repos/example/repo/git/ref/tags/$RELEASE_TAG" ]]; then
  case "$TEST_CASE" in
    remote-mismatch) printf 'commit\\twrong-commit\\n' ;;
    absent-annotated) printf 'tag\\tannotation-sha\\n' ;;
    *) printf 'commit\\tfixture-commit\\n' ;;
  esac
elif [[ "$1" == api && "$2" == 'repos/example/repo/git/tags/annotation-sha' ]]; then
  printf 'commit\\tfixture-commit\\n'
elif [[ "$1" == release && "$2" == create ]]; then
  printf '%s\\n' "$*" >> "$CALL_LOG"
  while [[ "$1" != -- ]]; do shift; done
  shift
  for asset in "$@"; do
    name=$(basename "$asset" | tr ' ' '.')
    cp -- "$asset" "$DOWNLOAD_DIR/$name"
  done
else
  echo 'Unexpected gh invocation' >&2; exit 90
fi
`, { mode: 0o755 });
    const digest = createHash('sha256').update('synthetic artifact').digest('hex');
    for (const scenario of ['draft', 'published', 'api-error', 'partial-error', 'corrupt-linux', 'corrupt-windows', 'corrupt-nupkg', 'missing-linux', 'missing-windows-zip', 'missing-windows-exe', 'commit-mismatch', 'remote-mismatch', 'absent', 'absent-build', 'absent-annotated', 'absent-prerelease', 'absent-public']) {
      const working = join(dir, scenario);
      const downloaded = join(working, 'downloaded');
      mkdirSync(downloaded, { recursive: true });
      mkdirSync(join(working, 'linux'));
      mkdirSync(join(working, 'windows'));
      const version = scenario === 'absent-build' ? '0.1.1+build.4' : scenario === 'absent-prerelease' ? '0.1.1-rc.1' : '0.1.0';
      const incoming = `MSFS Career Approach Companion-linux-x64-${version}.zip`;
      writeFileSync(join(working, 'linux', incoming), scenario === 'corrupt-linux' ? 'corrupted artifact' : 'synthetic artifact');
      writeFileSync(join(working, 'linux', 'SHA256SUMS'), `${digest}  ${incoming}\n`);
      const windowsFiles = ['msfs2024-mission-companion-windows-x64.zip', 'msfs2024-mission-companion-windows-x64-setup.exe', 'fixture-full.nupkg', 'RELEASES'];
      for (const file of windowsFiles) writeFileSync(join(working, 'windows', file), 'synthetic artifact');
      writeFileSync(join(working, 'windows', 'SHA256SUMS'), windowsFiles.map(file => `${digest}  ${file}\n`).join(''));
      if (scenario === 'corrupt-windows') writeFileSync(join(working, 'windows', windowsFiles[0]), 'corrupted');
      if (scenario === 'corrupt-nupkg') writeFileSync(join(working, 'windows', windowsFiles[2]), 'corrupted');
      if (scenario === 'missing-linux') rmSync(join(working, 'linux', incoming));
      if (scenario.startsWith('missing-windows')) {
        const missing = windowsFiles[scenario.endsWith('zip') ? 0 : 1];
        rmSync(join(working, 'windows', missing));
        // Even a valid manifest of the remaining files must not permit an incomplete release.
        writeFileSync(join(working, 'windows', 'SHA256SUMS'), windowsFiles.filter(file => file !== missing).map(file => `${digest}  ${file}\n`).join(''));
      }
      const log = join(working, 'created');
      rmSync(log, { force: true });
      const result = spawnSync(bash, ['-c', script], { cwd: working, encoding: 'utf8', env: {
        ...process.env, PATH: `${shellPath(dir)}:/usr/bin:/bin`, GH_REPO: 'example/repo', RELEASE_TAG: `v${version}`,
        EXPECTED_COMMIT: 'fixture-commit', WINDOWS_COMMIT: scenario === 'commit-mismatch' ? 'wrong-commit' : 'fixture-commit',
        PRERELEASE: String(scenario === 'absent-prerelease'), PUBLICATION_ENABLED: scenario === 'absent-public' ? 'true' : '',
        TEST_CASE: scenario, CALL_LOG: shellPath(log), DOWNLOAD_DIR: shellPath(downloaded),
      } });
      if (scenario.startsWith('absent')) {
        assert.equal(result.status, 0, result.stderr);
        assert(existsSync(log), 'An absent exact tag can create a release');
        execFileSync(bash, ['-c', 'sha256sum --check SHA256SUMS'], { cwd: downloaded });
        assert.deepEqual(readdirSync(downloaded).sort(), ['SHA256SUMS', 'msfs2024-mission-companion-linux-x64.zip', ...windowsFiles.slice(0, 2)].sort());
        const invocation = readFileSync(log, 'utf8');
        assert.equal(invocation.trim().split('\n').length, 1, 'Exactly one release creation');
        assert(invocation.includes('--verify-tag --target fixture-commit'));
        assert.equal(invocation.includes('--draft'), scenario !== 'absent-public');
        assert.equal(invocation.includes('--prerelease'), scenario === 'absent-prerelease');
        assert.equal(readFileSync(join(downloaded, 'msfs2024-mission-companion-linux-x64.zip'), 'utf8'), 'synthetic artifact');
      } else {
        assert.notEqual(result.status, 0, `${scenario} must block release creation`);
        assert(!existsSync(log), `${scenario} must leave releases untouched`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
