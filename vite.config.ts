import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  // license: the notices that React and xterm.js ask for travel inside the bundle's own folder, which `files` ships
  build: { outDir: 'dist/client', emptyOutDir: true, license: { fileName: 'THIRD-PARTY-NOTICES.md' } },
  server: { proxy: { '/api': 'http://127.0.0.1:7777', '/ws': { target: 'ws://127.0.0.1:7777', ws: true } } },
});
