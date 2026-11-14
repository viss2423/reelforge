import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, type UserConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { pwaManifest } from './pwa-manifest.ts'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

/** Backend the dev server proxies `/api` (HTTP + WebSocket) to. */
const apiTarget = process.env.REELFORGE_API ?? 'https://localhost:8443'

export default defineConfig(({ command, mode }) => {
  // A shell-wide NODE_ENV=development (or Playwright's NODE_ENV=test) would otherwise yield
  // React's development bundles and the dev JSX runtime in a production build. Vite reads
  // NODE_ENV after loading this file, so setting it here is the supported override.
  if (command === 'build' && mode === 'production') process.env.NODE_ENV = 'production'
  return config
})

const config: UserConfig = {
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    // React Compiler (stable Babel build): automatic memoisation keeps the editor's
    // re-render cost proportional to what actually changed.
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifest: pwaManifest,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  // jassub resolves its worker/WASM via `new URL(..., import.meta.url)`; pre-bundling would
  // move the module and break those URLs.
  optimizeDeps: { exclude: ['jassub'] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false, secure: false, ws: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false, secure: false, ws: true },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
    reportCompressedSize: true,
  },
}
