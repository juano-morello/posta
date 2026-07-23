import { expect, test } from '@playwright/test';

// T6.4.10 — POSTA.md §8.3/DESIGN.md §1: terminal/log "islands" (login
// card, bio page, 404, recibos) are ALWAYS dark, in both themes — `.light`
// must never touch them. Measured via real computed style (getComputedStyle),
// not a className string: a CSS custom property WOULD silently resolve to
// a different colour under `.light` even while the class name stayed
// identical, which is exactly the class of bug a jsdom/Testing Library
// assertion cannot see (T6.3's own postmortem — see globals.css's comment).
test.describe('Recibos dark island (T6.4.10)', () => {
  async function backgroundColor(page: import('@playwright/test').Page, testId: string): Promise<string> {
    return page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) {
        throw new Error(`islands.spec.ts: [data-testid="${id}"] not found`);
      }
      return getComputedStyle(el).backgroundColor;
    }, testId);
  }

  test('background is identical under dark and .light', async ({ page }) => {
    await page.goto('/recibos-preview');

    const dark = await backgroundColor(page, 'recibos');
    // #0D1117 -> rgb(13, 17, 23)
    expect(dark).toBe('rgb(13, 17, 23)');

    await page.evaluate(() => document.documentElement.classList.add('light'));
    const light = await backgroundColor(page, 'recibos');
    expect(light).toBe(dark);
  });

  test('carries the tail -f prompt line and a live dot', async ({ page }) => {
    await page.goto('/recibos-preview');
    await expect(page.getByText(/~\/posta \$ tail -f recibos --link=/)).toBeVisible();
    await expect(page.getByTestId('recibos-live-dot')).toBeVisible();
  });
});
