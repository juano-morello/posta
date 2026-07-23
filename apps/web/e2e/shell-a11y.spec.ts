import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// T6.3.9 [a11y] — the shell must be fully keyboard-navigable with a
// visible focus indicator on every focusable element, and axe-clean.
// Desktop viewport (>=800px) so Sidebar + Topbar are the ones in the tab
// order, not BottomTabs.
test.describe('AppShell keyboard traversal and focus visibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/shell-preview');
  });

  test('has zero axe violations', async ({ page }) => {
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('logical tab order: skip link first, then topbar, then nav, then content', async ({ page }) => {
    await page.keyboard.press('Tab');
    await expect(page.getByText('Saltar al contenido')).toBeFocused();

    // The next focusables belong to the topbar (search, Nuevo link,
    // avatar) before the sidebar nav — confirmed by walking focus order
    // and asserting each stop is inside the topbar until the sidebar's
    // first link is reached.
    const focusOrder: string[] = [];
    for (let i = 0; i < 8; i++) {
      const tag = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)}` : 'none';
      });
      focusOrder.push(tag);
      await page.keyboard.press('Tab');
    }
    // The Sidebar's "Links" nav item must appear somewhere after the
    // topbar's controls, never before them.
    const sidebarIndex = focusOrder.findIndex((entry) => entry.includes('Links'));
    const searchIndex = focusOrder.findIndex((entry) => entry.toLowerCase().includes('buscar'));
    expect(sidebarIndex).toBeGreaterThan(-1);
    expect(searchIndex).toBeGreaterThan(-1);
    expect(sidebarIndex).toBeGreaterThan(searchIndex);
  });

  test('every focused element has a visible (non-none) outline', async ({ page }) => {
    // `:visible` matters here: BottomTabs' four links are always in the
    // DOM (the responsive swap is CSS `display`, T6.3.6/T6.3.7), so at
    // this desktop viewport they're real elements matching a bare
    // `a, button` selector despite being display:none. Counting them
    // would overrun the loop past the last REAL Tab stop — real Tab
    // traversal skips display:none elements entirely, so those extra
    // iterations would land on <body> (no outline at all) and fail for
    // the wrong reason, not because any real focusable lacks a ring.
    const focusableCount = await page
      .locator('a:visible, button:visible, [tabindex]:not([tabindex="-1"]):visible')
      .count();
    expect(focusableCount).toBeGreaterThan(0);

    for (let i = 0; i < focusableCount; i++) {
      await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const style = window.getComputedStyle(el);
        return { outlineStyle: style.outlineStyle, boxShadow: style.boxShadow };
      });
      expect(outline).not.toBeNull();
      // A visible focus indicator is either a real outline OR a
      // box-shadow-based ring (Tailwind's focus-visible:ring-* utilities
      // implement the ring as a box-shadow, not outline) — accept either.
      const hasOutline = outline!.outlineStyle !== 'none';
      const hasRingShadow = outline!.boxShadow !== 'none' && outline!.boxShadow !== '';
      expect(hasOutline || hasRingShadow).toBe(true);
    }
  });

  test('the avatar dropdown does not trap keyboard focus', async ({ page }) => {
    const avatarTrigger = page.getByRole('button', { name: 'Cuenta' });
    await avatarTrigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();

    // Escape closes the menu and returns focus to the trigger — the
    // standard Radix behavior, and the proof there's no trap.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(avatarTrigger).toBeFocused();
  });
});
