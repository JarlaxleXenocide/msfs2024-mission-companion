import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const packageMetadata = require('./package.json') as { author: string; description: string };

// Supported by electron-winstaller metadata but omitted from its options type.
const squirrelAdditionalFiles = { additionalFiles: [
  { src: 'LICENSES.chromium.html', target: 'lib\\net45\\LICENSES.chromium.html' },
  { src: 'version', target: 'lib\\net45\\version' },
] };

const config: ForgeConfig = {
  packagerConfig: { asar: true, executableName: 'career-companion', extraResource: ['THIRD-PARTY-LICENSES.md'] },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'msfsCareerApproachCompanion',
      exe: 'career-companion.exe',
      setupExe: 'msfs2024-mission-companion-windows-x64-setup.exe',
      authors: packageMetadata.author,
      description: packageMetadata.description,
      ...squirrelAdditionalFiles,
    }),
    new MakerZIP({}, ['linux', 'win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/index.ts',
            name: 'main_window',
            preload: { js: './src/preload.ts' },
          },
        ],
      },
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
