import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/media': 'http://127.0.0.1:8080',
      '/static': 'http://127.0.0.1:8080',
    },
  },
});
