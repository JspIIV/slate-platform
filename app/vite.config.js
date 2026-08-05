import { defineConfig } from 'vite';

// Built straight into the server's static directory, so one process serves the
// API and the app and there is no second thing to deploy.
export default defineConfig({
  build: { outDir: '../public', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
