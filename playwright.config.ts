import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list'], ['json', { outputFile: 'spike-output/readiness/e2e.json' }]],
  outputDir: 'spike-output/playwright-results',
  webServer: [
    {
      command: 'node test/browser-server.ts',
      url: 'http://127.0.0.1:3000/v1/health',
      reuseExistingServer: false,
      timeout: 90000,
    },
    {
      command: 'pnpm dev:web --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
