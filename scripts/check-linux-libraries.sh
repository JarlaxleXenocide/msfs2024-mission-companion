#!/usr/bin/env bash
# Shared-library compatibility only: never launches Electron or contacts MSFS.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
alsa=libasound2
gtk=libgtk-3-0
if [[ "$ID:$VERSION_ID" == ubuntu:24.04 ]]; then
  alsa=libasound2t64
  gtk=libgtk-3-0t64
fi
apt-get update
apt-get install --yes --no-install-recommends unzip libnss3 "$gtk" libgbm1 "$alsa"
mkdir /package
unzip -q /artifacts/*.zip -d /package
cd '/package/MSFS Career Approach Companion-linux-x64'
for binary in career-companion chrome_crashpad_handler chrome-sandbox *.so*; do
  echo "Checking $binary on $PRETTY_NAME"
  dependencies=$(ldd "./$binary")
  echo "$dependencies"
  if [[ "$dependencies" == *'not found'* ]]; then exit 1; fi
done
echo 'Shared-library check passed; desktop and simulator behavior remain untested here.'
