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

// T6.5.3 — all twelve shadcn primitives (T6.2.2-9's own "Installed and
// themed: button, input, sheet, dialog, toast, dropdown, tabs, select,
// switch, tooltip, skeleton, badge" list), each with a real section
// heading so this test can enumerate them the same way a developer
// scanning the anchor nav would.
const SHADCN_PRIMITIVES = [
  'Button',
  'Input',
  'Select',
  'Switch',
  'Sheet',
  'Dialog',
  'Dropdown menu',
  'Tooltip',
  'Toast',
  'Tabs',
  'Skeleton',
  'Badge',
];

test.describe('/gallery shadcn primitives (T6.5.3)', () => {
  test('has a section heading for each of the twelve primitives', async ({ page }) => {
    await page.goto('/gallery');
    // exact: true — Playwright's `name` option substring-matches by
    // default, and "Badge" is a substring of the honesty section's own
    // "BadgeHumano" heading (T6.5.4), so a loose match here is ambiguous
    // the moment both sections exist on the same page.
    for (const name of SHADCN_PRIMITIVES) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
  });

  test('renders the five Button variants', async ({ page }) => {
    await page.goto('/gallery');
    for (const label of ['Primary', 'Secondary', 'Outline', 'Ghost', 'Destructive']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });
});

// T6.5.4 — HumanoBar, BadgeHumano, SourceChip and Recibos from the
// fixtures module (T6.5.2), in their normal (non-edge-case) state.
// Recibos is shown as a live island — the real component, not a
// screenshot: its own prompt line + pulsing dot render exactly as they
// do everywhere else in the app.
test.describe('/gallery honesty primitives (T6.5.4)', () => {
  test('all four honesty primitives render with fixture data', async ({ page }) => {
    await page.goto('/gallery');

    const honestySection = page.getByRole('region', { name: 'Honesty primitives' });
    await expect(honestySection.getByTestId('gallery-humano-bar').getByRole('img')).toBeVisible();
    await expect(honestySection.getByTestId('gallery-badge-humano').getByText('60% humano')).toBeVisible();
    // Scoped to the SourceChip block specifically: 'Instagram' is
    // deliberately ALSO a Recibos fixture row's source (GALLERY_RECEIPTS),
    // so a page-wide match is ambiguous once both are on the same page.
    await expect(
      honestySection.getByTestId('gallery-source-chip').getByText('Instagram', { exact: true }),
    ).toBeVisible();
    await expect(honestySection.getByTestId('recibos')).toBeVisible(); // Recibos
    await expect(honestySection.getByTestId('recibos-live-dot')).toBeVisible();
  });
});

// T6.5.5 — Sidebar/Topbar (desktop) and BottomTabs (mobile) inspectable
// on ONE page without resizing the real browser window. AppShell's
// desktop/mobile swap (T6.3.6) is a real CSS media query keyed on the
// VIEWPORT's width, not a containing element's width — so two divs of
// different widths side by side on the same page would both see the
// SAME (outer) viewport and render identically. An <iframe> is a
// genuinely separate browsing context with its own viewport matching its
// own width/height attributes, which is what actually makes both
// breakpoints render correctly, simultaneously, on this one page — hence
// "framed viewports" in the task's own wording.
test.describe('/gallery shell frames (T6.5.5)', () => {
  test('renders both the desktop and mobile shell frames simultaneously', async ({ page }) => {
    await page.goto('/gallery');

    const desktopFrame = page.getByTestId('shell-frame-desktop');
    const mobileFrame = page.getByTestId('shell-frame-mobile');
    await expect(desktopFrame).toBeVisible();
    await expect(mobileFrame).toBeVisible();

    const desktopNav = desktopFrame.contentFrame().locator('nav[aria-label="Principal"]:not(.fixed)');
    const desktopBottomTabs = desktopFrame.contentFrame().locator('nav[aria-label="Principal"].fixed');
    await expect(desktopNav).toBeVisible();
    await expect(desktopBottomTabs).toBeHidden();

    const mobileNav = mobileFrame.contentFrame().locator('nav[aria-label="Principal"]:not(.fixed)');
    const mobileBottomTabs = mobileFrame.contentFrame().locator('nav[aria-label="Principal"].fixed');
    await expect(mobileNav).toBeHidden();
    await expect(mobileBottomTabs).toBeVisible();
  });
});

