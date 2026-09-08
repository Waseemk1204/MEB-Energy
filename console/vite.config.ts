/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Vite does not read PORT on its own, and the preview harness assigns the
  // port that way. Without this it picks its own and the preview points at
  // nothing.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : {},
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    /*
     * The default 5s is not enough under a full run.
     *
     * These tests drive multi-step user interactions against a jsdom tree, and
     * fourteen jsdom environments are built in parallel. On a loaded machine a
     * handful of unrelated tests would cross 5s and fail together — around one
     * run in four, never the same tests twice, and never when a file was run on
     * its own. That reads exactly like a real intermittent bug and is not one,
     * which is the expensive kind of flake: it costs more in chased phantoms
     * than the ten seconds it costs here.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
