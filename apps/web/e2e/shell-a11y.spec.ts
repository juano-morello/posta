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

  test('logical tab order: skip link, then topbar, then nav, then content', async ({ page }) => {
    // T6.3.9's own a11y review found a CRITICAL bug here: an earlier
    // flexbox + `order-*` AppShell nested <main> inside the same DOM
    // subtree as Topbar, so real focusable content landed in Tab order
    // BETWEEN Topbar and Sidebar, not after both — and this exact test
    // couldn't catch it, because the fixture page had zero focusable
    // elements inside <main> at the time. The "Ver más" button added to
    // shell-preview/page.tsx exists specifically so this assertion can be
    // real: AppShell is now CSS Grid (skip-link, topbar, sidebar, main as
    // four independent grid items in that DOM order), not nested flexbox.
    await page.keyboard.press('Tab');
    await expect(page.getByText('Saltar al contenido')).toBeFocused();

    const focusOrder: string[] = [];
    for (let i = 0; i < 9; i++) {
      const tag = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)}` : 'none';
      });
      focusOrder.push(tag);
      await page.keyboard.press('Tab');
    }
    const searchIndex = focusOrder.findIndex((entry) => entry.toLowerCase().includes('buscar'));
    const sidebarIndex = focusOrder.findIndex((entry) => entry.includes('Links'));
    const contentIndex = focusOrder.findIndex((entry) => entry.includes('Ver más'));
    expect(searchIndex).toBeGreaterThan(-1);
    expect(sidebarIndex).toBeGreaterThan(-1);
    expect(contentIndex).toBeGreaterThan(-1);
    // topbar -> nav -> content, strictly in that order.
    expect(sidebarIndex).toBeGreaterThan(searchIndex);
    expect(contentIndex).toBeGreaterThan(sidebarIndex);
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

// T6.3.9's own a11y review, Finding 4: the desktop-only describe block
// above forces `page.setViewportSize({ width: 1280, ... })` in its own
// beforeEach — including under the `mobile` Playwright project, whose
// default 390x844 viewport it overrides right back to 1280x800. That
// left BottomTabs and CompactMobileTopbar (the one thing T6.3.5 actually
// added — the 44px floor, the ring-inset focus style, the safe-area
// padding) completely unexercised by axe or by a real keyboard/computed-
// style check, despite this task being titled "...across the whole
// shell." This block runs the same two checks at the mobile width.
test.describe('AppShell mobile layout (390px) — the shell T6.3.5 actually changed', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/shell-preview');
  });

  test('has zero axe violations at mobile width', async ({ page }) => {
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('every visible BottomTabs/CompactMobileTopbar focusable has a visible ring', async ({ page }) => {
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
      const hasOutline = outline!.outlineStyle !== 'none';
      const hasRingShadow = outline!.boxShadow !== 'none' && outline!.boxShadow !== '';
      expect(hasOutline || hasRingShadow).toBe(true);
    }
  });
});
