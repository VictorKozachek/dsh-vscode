import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Сборка WebView-панели. Ассеты кладутся рядом с `index.html` и грузятся
 * относительными путями (`base: './'`), чтобы они работали из
 * `webview/dist` в WebView расширения.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
