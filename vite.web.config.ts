import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'

// Standalone WEB build of the renderer for the public demo on byronthegreat.com.
// Differences from the Electron renderer build:
//  - 'socket.io-client' is aliased to the demo fake socket (simulated ride data)
//  - base is relative ('./') so it can be hosted at any subpath (/projects/motocarplay/)
//  - entry is demo.html → src/demo/main.tsx (installs browser stubs for the
//    Electron preload bridge, then mounts the real App)
const alias = {
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@carplay/web': resolve(__dirname, 'src/renderer/components/web/CarplayWeb.ts'),
  '@carplay/messages': resolve(__dirname, 'src/main/carplay/messages'),
  '@carplay': resolve(__dirname, 'src/main/carplay'),
  stream: 'stream-browserify',
  Buffer: 'buffer',
  // Demo swap: the dashboard's data source.
  'socket.io-client': resolve(__dirname, 'src/renderer/src/demo/mockSocket.ts'),
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: resolve(__dirname, 'src/renderer/public'),
  resolve: { alias },
  define: {
    global: 'globalThis',
    'process.env': {},
  },
  optimizeDeps: {
    esbuildOptions: {
      define: { global: 'globalThis' },
      plugins: [NodeGlobalsPolyfillPlugin({ process: true, buffer: true })],
    },
  },
  plugins: [react({})],
  worker: { format: 'es' },
  build: {
    outDir: resolve(__dirname, 'web-dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        // Landing page (white bg, header, bezel) → becomes index.html on deploy.
        landing: resolve(__dirname, 'src/renderer/landing.html'),
        // The dashboard itself, loaded by the landing page inside an iframe.
        demo: resolve(__dirname, 'src/renderer/demo.html'),
      },
    },
  },
})
