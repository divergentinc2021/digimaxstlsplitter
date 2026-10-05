import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['manifold-3d'] },
  worker: { format: 'es' },
  build: { target: 'es2022' }
});