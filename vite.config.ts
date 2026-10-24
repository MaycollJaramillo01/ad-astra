import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// SPA (ADR-016). En desarrollo, /v1 se reenvía a la API local: mismo origen, como en Vercel.
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/v1': 'http://127.0.0.1:3000' } },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
