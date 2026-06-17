import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Required for Zoom Meeting SDK (CJS UMD bundle)
  optimizeDeps: {
    include: ['@zoom/meetingsdk/embedded'],
  },
  server: {
    headers: {
      // Required for Zoom SDK WebAssembly / SharedArrayBuffer
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
