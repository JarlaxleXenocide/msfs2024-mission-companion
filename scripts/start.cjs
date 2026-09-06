// Ozone must be selected on Electron's initial argv, before its main script runs.
if (process.platform === 'linux' && process.env.DISPLAY &&
    !process.argv.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))) {
  if (!process.argv.includes('--')) process.argv.push('--');
  process.argv.push('--ozone-platform=x11');
}
require('@electron-forge/cli/dist/electron-forge-start');
