import { expect, test } from '@playwright/test';

// T6.5.1 — the component gallery (S6.5): every primitive rendered in
// isolation, running with NO backend (fixtures only) so it works during
// E1-E4 while the API/worker are still being built. This spec grows
// task-by-task (T6.5.3-9 each add their own assertions to this same
// file), matching how page.tsx itself grows the same way.
test.describe('/gallery route (T6.5.1)', () => {
  test('returns 200 and issues zero network requests outside localhost', async ({ page }) => {
    const externalRequests: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.hostname !== 'localhost') {
        externalRequests.push(req.url());
      }
    });

    const response = await page.goto('/gallery');
    expect(response?.status()).toBe(200);
    expect(externalRequests).toEqual([]);
  });

  test('has a sectioned layout with a visible anchor nav', async ({ page }) => {
    await page.goto('/gallery');
    const nav = page.getByRole('navigation', { name: 'Secciones' });
    await expect(nav).toBeVisible();
    expect(await nav.getByRole('link').count()).toBeGreaterThan(0);
  });
});
