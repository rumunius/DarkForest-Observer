import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  plugins: [
    {
      name: 'preview-entry',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (
            req.url?.split('?')[0]?.startsWith('/dev-preview/') &&
            !req.url.includes('.')
          ) {
            req.url = '/dev-preview/index.html';
          }
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (
            req.url?.split('?')[0]?.startsWith('/dev-preview/') &&
            !req.url.includes('.')
          ) {
            req.url = '/dev-preview/index.html';
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {'/api': 'http://127.0.0.1:8788'},
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        preview: fileURLToPath(
          new URL('./dev-preview/index.html', import.meta.url),
        ),
      },
    },
  },
});
