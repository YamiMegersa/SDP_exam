import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const target = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
