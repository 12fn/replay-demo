import {defineConfig, configDefaults} from 'vitest/config';
import path from 'node:path';
export default defineConfig({resolve:{alias:{resources:path.resolve('vendor/openfront/resources'),src:path.resolve('vendor/openfront/src')}},test:{include:['tests/**/*.test.ts','src/client/**/*.test.ts'],exclude:[...configDefaults.exclude,'tests/private-fixtures/**'],maxWorkers:2,testTimeout:20000}});
