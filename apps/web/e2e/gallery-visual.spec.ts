import { expect, test } from '@playwright/test';

// T6.5.8 — four full-page snapshots (dark/light x 1280px/390px) that
// catch ANY unintended token or component regression across the WHOLE
// system in one pass, since /gallery renders every primitive from real
// fixtures.
//
// This file also delivers two S6.1/S6.2 tasks that were explicitly
// DEFERRED pending /gallery's existence (see PR #2's own body/progress
// notes): T6.2.10 ("snapshot every primitive in dark and light" —
// deferred from S6.2 because it needed a page to render all twelve
// primitives on) and T6.1.12 (the pre-hydration flash guard's own
// `gallery-no-fouc` snapshot — deferred for the same reason). Both land
// here rather than in a separate file, exactly as the prior session's
// notes said they would.
//
// CROSS-OS BASELINES (PR #2 review — CI was red without this): Playwright
// screenshot comparisons are sensitive to the OS/font-rendering
// environment they were recorded in, so `*-darwin.png` baselines (built
// on macOS, in this sandbox) don't match a Linux CI runner's rendering.
// `*-linux.png` baselines are committed alongside them, generated inside
// `mcr.microsoft.com/playwright:v1.61.1-noble` (the exact image/version
// matching this repo's `@playwright/test` pin) against an isolated copy
// of the repo — never against this worktree's own `node_modules`, so the
// container's Linux-native installs never touch the macOS ones this
// session depends on. Playwright's own snapshot resolution picks the
// right suffix for whichever OS is actually running the test, so both
// sets coexist here without either side needing to know about the
// other. Regenerate the `-linux.png` set the same way if this file's
// assertions ever change: `docker run --rm -v <isolated-copy>:/work -w
// /work mcr.microsoft.com/playwright:v1.61.1-noble bash -lc "corepack
// enable && pnpm install --frozen-lockfile && pnpm --filter
// @posta/contracts build && pnpm --filter @posta/web exec playwright
// test gallery-visual.spec.ts gallery.spec.ts --update-snapshots"`.
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };

async function setLight(page: import('@playwright/test').Page) {
  await page.evaluate(() => document.documentElement.classList.add('light'));
}

test.describe('/gallery full-page visual regression (T6.5.8)', () => {
  test('dark desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/gallery');
    await expect(page).toHaveScreenshot('gallery-dark-desktop.png', { fullPage: true });
  });

  test('light desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/gallery');
    await setLight(page);
    await expect(page).toHaveScreenshot('gallery-light-desktop.png', { fullPage: true });
  });

  test('dark mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/gallery');
    await expect(page).toHaveScreenshot('gallery-dark-mobile.png', { fullPage: true });
  });

  test('light mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/gallery');
    await setLight(page);
    await expect(page).toHaveScreenshot('gallery-light-mobile.png', { fullPage: true });
  });
});

// T6.2.10 (deferred from S6.2, delivered here) — "every primitive in
// both themes." Scoped to the gallery's own #shadcn section rather than
// a second, separate primitives.spec.ts/route: /gallery already renders
// the same twelve primitives from real fixtures, so a second render
// surface would just be a second place for them to drift apart.
test.describe('shadcn primitives visual regression (T6.2.10, delivered with T6.5.8)', () => {
  test('primitives dark', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/gallery');
    await expect(page.locator('#shadcn')).toHaveScreenshot('primitives-dark.png');
  });

  test('primitives light', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/gallery');
    await setLight(page);
    await expect(page.locator('#shadcn')).toHaveScreenshot('primitives-light.png');
  });
});

// T6.1.12 (deferred from S6.1, delivered here) — the pre-hydration
// blocking script must apply the correct theme class BEFORE first
// paint, so there is never a frame where the wrong theme is visible.
// That guarantee is structural (a synchronous, non-deferred <script> in
// <head> blocks parsing and runs before <body> renders at all — see
// layout.tsx's own comment), not something a screenshot can literally
// catch mid-flash: a screenshot captures one SETTLED point in time, not
// motion between two frames. The deterministic proof already lives in
// theme.test.tsx (T6.1.12's own unit test, asserting the script runs
// before hydration). What THIS test adds is the outward, visual
// confirmation — `.light` is provably absent at the earliest observable
// point after a plain (no-stored-preference, i.e. "stored dark") reload
// — completing the literal `gallery-no-fouc` snapshot the task names.
test.describe('theme flash-of-unstyled-content guard (T6.1.12, delivered with T6.5.8)', () => {
  test('no light class present on a stored-dark (default) reload', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/gallery');
    const hasLight = await page.evaluate(() => document.documentElement.classList.contains('light'));
    expect(hasLight).toBe(false);
    await expect(page).toHaveScreenshot('gallery-no-fouc.png', { fullPage: true });
  });
});
