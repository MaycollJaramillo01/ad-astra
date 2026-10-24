import { defineConfig } from 'vitest/config';
import { testEnv } from './test/env.ts';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: testEnv,
  },
});
