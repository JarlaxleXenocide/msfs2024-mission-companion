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
      {
        test: /\.png$/,
        type: 'asset/inline',
      },
    ],
  },
  resolve: { extensions: ['.js', '.ts', '.css'] },
};
