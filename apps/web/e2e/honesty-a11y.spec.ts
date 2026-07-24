import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T6.4.15 [a11y] — the four honesty primitives ARE the product (POSTA.md
// §1); colour is never allowed to be the only channel. Runs axe over all
// four together, in BOTH themes, and asserts every colour-encoded meaning
// (the classification verdict, the source platform) has a real text or
// aria-label equivalent — the verdict in a receipt reads as `[bot]`, not
// as red alone.
async function assertZeroAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

test.describe('Honesty primitives a11y (T6.4.15)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/honesty-preview');
  });

  test('zero axe violations in dark (default)', async ({ page }) => {
    await assertZeroAxeViolations(page);
  });

  test('zero axe violations in light', async ({ page }) => {
    await page.evaluate(() => document.documentElement.classList.add('light'));
    await assertZeroAxeViolations(page);
  });

  test('HumanoBar: role=img with an aria-label naming all four groups, plus a visible legend', async ({
    page,
  }) => {
    // No `s` (dotAll) flag: the tsconfig target doesn't support it, and
    // the aria-label is a single-line string anyway (buildAriaLabel
    // joins with ', ', never a newline), so plain `.` already matches.
    const bar = page.getByRole('img', { name: /humanos.*bots.*unfurlers.*prefetch/i });
    await expect(bar).toBeVisible();
    await expect(page.getByText('humanos')).toBeVisible();
    await expect(page.getByText('bots')).toBeVisible();
    await expect(page.getByText('unfurlers')).toBeVisible();
    await expect(page.getByText('prefetch').first()).toBeVisible();
  });

  test('BadgeHumano: the percentage is real visible text, not colour alone', async ({ page }) => {
    await expect(page.getByText('87% humano')).toBeVisible();
  });

  test('SourceChip: every platform has a visible text label beside its dot', async ({ page }) => {
    // Scoped to the SourceChip section specifically: 'Instagram' is
    // deliberately ALSO a Recibos row's source in this fixture, and a
    // page-wide getByText would be ambiguous between the two sections —
    // that's a fixture-authoring hazard, not a product bug.
    const section = page.getByRole('region', { name: 'SourceChip' });
    for (const platform of ['Instagram', 'WhatsApp', 'TikTok', 'directo']) {
      await expect(section.getByText(platform, { exact: true })).toBeVisible();
    }
  });

  test('Recibos: every classification renders its bracketed verdict as visible text', async ({ page }) => {
    for (const bracket of ['[bot]', '[prefetch]', '[unfurler]', '[humano]']) {
      await expect(page.getByText(bracket)).toBeVisible();
    }
  });

  test('HumanoBar: each present segment has a real, non-transparent computed border colour', async ({
    page,
  }) => {
    // T6.4.15's carried-forward fix: className alone doesn't prove the
    // Tailwind border-color utility actually resolved to a real colour in
    // a real browser (S6.3's own postmortem — see globals.css's comment —
    // is exactly a className string passing while the real CSS was
    // inert). Measured via getComputedStyle, not the class name.
    const colors = await page.evaluate(() => {
      const ids = ['humano-bar-segment-humano', 'humano-bar-segment-bot'];
      return ids.map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) throw new Error(`honesty-a11y.spec.ts: [data-testid="${id}"] not found`);
        const style = getComputedStyle(el);
        return { id, borderColor: style.borderColor, borderWidth: style.borderWidth };
      });
    });

    for (const { id, borderColor, borderWidth } of colors) {
      expect(borderWidth, `${id} borderWidth`).not.toBe('0px');
      expect(borderColor, `${id} borderColor`).not.toBe('rgba(0, 0, 0, 0)');
      expect(borderColor, `${id} borderColor`).not.toBe('transparent');
    }
  });
});
