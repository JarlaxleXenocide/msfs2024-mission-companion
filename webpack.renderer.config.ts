import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';

export const rendererConfig: Configuration = {
  devtool: 'source-map',
  module: {
    rules: [
      ...rules,
      {
        test: /\.css$/,
        type: 'asset/resource',
      },
    ],
  },
  resolve: { extensions: ['.js', '.ts', '.css'] },
};
