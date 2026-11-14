import { defineConfig } from '@playwright/test'

// Runs against the browser build with the in-memory core (mock). The real Tauri window is not
// automatable this way; the Rust core has its own cargo tests.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: true,
  // One retry: on this Windows machine many parallel browsers sometimes hit net::ERR_NO_BUFFER_SPACE. Playwright lists such tests as flaky, so a real intermittent bug still shows.
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:1420',
    channel: 'msedge', // the Edge already installed; no browser download
    viewport: { width: 1440, height: 900 },
    // no fades: an accessibility scan taken in the middle of a colour change would measure a colour that is on screen for a moment only
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 1420 --strictPort',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
