import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8788' },
  },
  build: { target: 'es2022', sourcemap: false },
});
