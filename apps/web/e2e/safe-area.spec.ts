import { expect, test } from '@playwright/test';

// T6.3.5's own a11y review, Finding 2: `pb-[env(safe-area-inset-bottom)]`
// compiles to valid CSS, but every env(safe-area-inset-*) resolves to 0
// unless the page's viewport declares viewport-fit=cover. This asserts
// the actual fix (layout.tsx's `viewport: { viewportFit: 'cover' }`) is
// present in the rendered HTML.
//
// This is deliberately NOT a "computed padding-bottom > 0" assertion.
// Tried that first, empirically, on both Chromium (with an iPhone 14
// Pro's exact viewport/isMobile/hasTouch/userAgent properties) and real
// WebKit (Playwright's own bundled engine, installed specifically to
// test this) — both computed exactly 0. env(safe-area-inset-*)'s
// non-zero resolution depends on the HOST OPERATING SYSTEM reporting
// real notch/home-indicator geometry through native APIs; no headless
// browser automation tool, regardless of rendering engine, runs on
// hardware with an actual notch, so no automated test in this or any
// standard CI environment can observe a non-zero value here. That is a
// known, fundamental limitation of testing this specific CSS feature
// (verifiable only on a real device or Xcode's iOS Simulator) — not a
// gap in this test. Asserting the meta tag is the correct, achievable
// proxy for "the fix that makes safe-area resolution POSSIBLE is wired
// up"; the downstream OS-dependent resolution itself is out of reach.
test('the viewport meta tag declares viewport-fit=cover', async ({ page }) => {
  await page.goto('/shell-preview');
  const content = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(content).toContain('viewport-fit=cover');
});
