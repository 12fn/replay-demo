import {defineConfig} from 'vitest/config';
import path from 'node:path';
import './root';

export default defineConfig({
  resolve: {alias: {resources: path.resolve('vendor/openfront/resources'), src: path.resolve('vendor/openfront/src')}},
  test: {include: ['tests/private-fixtures/**/*.test.ts'], maxWorkers: 2, testTimeout: 20_000},
});
