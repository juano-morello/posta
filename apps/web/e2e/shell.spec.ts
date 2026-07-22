import { expect, test } from '@playwright/test';

// T6.3.6 — the swap is CSS-driven off the `mobile` Tailwind screen (a
// real min-width media query at 800px), not a JS width listener, so it
// must be correct on a server-rendered load with JS disabled — a JS
// width-listener implementation would render nothing (or the wrong
// layout) until hydration ran, which this test would catch.
test.describe('AppShell responsive breakpoint swap (JS disabled)', () => {
  test.use({ javaScriptEnabled: false });

  test('desktop (1280px): sidebar visible, bottom tab bar hidden', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/shell-preview');

    // Both <nav aria-label="Principal"> elements are always in the DOM
    // (the swap is CSS-only) — getByRole excludes the CSS-hidden one from
    // the accessibility tree by design (matching real assistive-tech
    // behavior), so it only ever resolves the one currently visible.
    // Sidebar (not `fixed`) must be visible; BottomTabs (`fixed`) hidden.
    const sidebarNav = page.locator('nav[aria-label="Principal"]:not(.fixed)');
    const bottomTabsNav = page.locator('nav[aria-label="Principal"].fixed');
    await expect(sidebarNav).toBeVisible();
    await expect(bottomTabsNav).toBeHidden();
  });

  test('mobile (390px): sidebar hidden, bottom tab bar visible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/shell-preview');

    const sidebarNav = page.locator('nav[aria-label="Principal"]:not(.fixed)');
    const bottomTabsNav = page.locator('nav[aria-label="Principal"].fixed');
    await expect(sidebarNav).toBeHidden();
    await expect(bottomTabsNav).toBeVisible();
  });
});
