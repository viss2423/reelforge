/**
 * Vite config for the preview dev harness (independent of the app's vite.config.ts):
 *
 *   node apps/web/src/preview/dev/fixtures.ts          # once: demo media → dev/.media
 *   pnpm --filter @reelforge/web exec vite --config src/preview/dev/vite.config.ts
 *
 * - serves dev/.media at the root (sirv answers HTTP Range, like the server's proxy route);
 * - keeps JASSUB out of dependency pre-bundling so its `new URL(…, import.meta.url)` worker
 *   and WASM references resolve to the package files.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  publicDir: '.media',
  // …but its CommonJS dependency still needs pre-bundling to get an ESM default export
  optimizeDeps: { exclude: ['jassub'], include: ['jassub > throughput'] },
  server: { host: '127.0.0.1', port: 5199, strictPort: false },
  build: { target: 'es2024' },
})
