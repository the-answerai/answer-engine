import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@answer-engine/cli/scaffold': resolve(__dirname, '../cli/src/scaffold.ts'),
      '@answer-engine/cli/wiring': resolve(__dirname, '../cli/src/wiring/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
