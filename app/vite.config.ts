import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1', fs: { allow: ['..'] } },
  build: { target: 'chrome105', sourcemap: true },
  test: { environment: 'jsdom', globals: true, include: ['src/**/*.test.ts'] },
})
