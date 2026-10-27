import { defineConfig } from 'vitest/config';
import { testEnv } from './test/env.ts';

export default defineConfig({
  test: {
    // La suite comparte Postgres y tiene experimentos numéricos: limitar procesos evita
    // agotar CPU/conexiones y producir timeouts de 5 s al crecer el número de módulos.
    maxWorkers: 4,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: testEnv,
  },
});
