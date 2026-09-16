import { defineConfig } from 'vite';

// Client only. JSX uses Vite's built-in automatic runtime transform (no extra plugin required).
export default defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5181', changeOrigin: false },
    },
  },
  preview: { host: '127.0.0.1', port: 5180 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
