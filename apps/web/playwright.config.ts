import { defineConfig, devices } from '@playwright/test';

// E6 test tooling — Playwright drives the visual-regression and a11y specs
// under apps/web/e2e/** (T6.1.12, T6.2.10, T6.3.9, T6.4.15, T6.5.8/9). It is
// deliberately separate from Vitest's 'web' project (vitest.config.ts): those
// are component-level (jsdom + Testing Library), these are full-browser —
// real layout, real fonts, real CSS cascade — which a11y and pixel-snapshot
// assertions need and jsdom cannot provide.
//
// Two projects cover the breakpoints the plan's tasks assert against
// directly (1280px desktop / 390px mobile, DESIGN.md's $bp-mobile: 800px
// swap) rather than relying on Playwright's generic device presets, which
// use viewport sizes chosen for realism, not for landing exactly on this
// repo's own breakpoint.
const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
