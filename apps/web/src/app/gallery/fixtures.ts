import { z } from 'zod';
import { zClasificacion, zSourcePlatform } from '@posta/contracts';

// T6.5.2 — the single place gallery data comes from: every /gallery
// entry (T6.5.3-6) reads a fixture from here, never a live endpoint —
// this is what keeps the gallery working with NO backend (S6.5's own
// acceptance criterion), true from E1 through E4 and beyond.
//
// zGalleryRecibo/zGallerySplit validate against the REAL `@posta/contracts`
// enums (T6.4.1): `cls`/`src` can only ever be one of the four real
// verdicts/platforms, so a typo here fails this file's own test, not a
// downstream screen's.
//
// zGalleryLink is NOT a real contracts schema — `packages/contracts/src/
// links.ts` is E1's own task (T1.1.11, data model), not yet built on
// this branch. This is a minimal LOCAL stand-in scoped to exactly what
// the gallery needs to render a links-list-shaped fixture. Promote or
// delete it once E1 lands the real one; do not let two definitions of
// "Link" coexist past that point.
export const zGalleryLink = z.object({
  id: z.string(),
  handle: z.string(),
  slug: z.string(),
  destination: z.string().url(),
  clicksReales: z.number().int().nonnegative(),
});
export type GalleryLink = z.infer<typeof zGalleryLink>;

export const zGalleryRecibo = z.object({
  id: z.string(),
  t: z.string(),
  src: zSourcePlatform,
  cls: zClasificacion,
  why: z.string(),
});
export type GalleryRecibo = z.infer<typeof zGalleryRecibo>;

export const zGallerySplit = z.object({
  humano: z.number().int().nonnegative(),
  bot: z.number().int().nonnegative(),
  unfurler: z.number().int().nonnegative(),
  prefetch: z.number().int().nonnegative(),
});
export type GallerySplit = z.infer<typeof zGallerySplit>;

export const GALLERY_LINKS: GalleryLink[] = [
  {
    id: '01J0000000000000000000LNK1',
    handle: 'juano',
    slug: 'promo',
    destination: 'https://example.test/verano-2026',
    clicksReales: 1284,
  },
  {
    id: '01J0000000000000000000LNK2',
    handle: 'juano',
    slug: 'live',
    destination: 'https://example.test/stream',
    clicksReales: 342,
  },
];

export const GALLERY_RECEIPTS: GalleryRecibo[] = [
  { id: '01J0000000000000000000REC1', t: '14:32:01', src: 'Instagram', cls: 'bot', why: "user-agent 'python-requests'" },
  { id: '01J0000000000000000000REC2', t: '14:31:47', src: 'directo', cls: 'prefetch', why: 'preview de link · dwell 0 ms' },
  { id: '01J0000000000000000000REC3', t: '14:31:20', src: 'WhatsApp', cls: 'unfurler', why: 'facebookexternalhit' },
  { id: '01J0000000000000000000REC4', t: '14:30:58', src: 'TikTok', cls: 'humano', why: '—' },
];

export const GALLERY_SPLIT: GallerySplit = { humano: 60, bot: 20, unfurler: 12, prefetch: 8 };

// T6.5.6 — the cases the honesty primitives are most likely to break on
// (each one already has its own dedicated unit test — T6.4.4/T6.4.5 for
// HumanoBar, T6.4.13 for the why payload — but the gallery is where a
// human actually LOOKS at them rendered, in both themes, which a passing
// unit test alone never proves).
export const EDGE_CASE_HUMANO_BAR_SPLITS: Record<string, GallerySplit> = {
  zeroClicks: { humano: 0, bot: 0, unfurler: 0, prefetch: 0 },
  allHuman: { humano: 100, bot: 0, unfurler: 0, prefetch: 0 },
  noHuman: { humano: 0, bot: 50, unfurler: 30, prefetch: 20 },
  tinySegment: { humano: 9999, bot: 1, unfurler: 0, prefetch: 0 }, // 1-in-10000
};

export const EDGE_CASE_RECEIPTS: GalleryRecibo[] = [
  {
    id: '01J0000000000000000000EDG1',
    t: '14:27:33',
    src: 'directo',
    cls: 'bot',
    // Long enough to wrap across multiple lines inside Recibos' fixed-
    // width island rather than forcing the page to scroll horizontally.
    why: "user-agent 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html) AppleWebKit/537.36 (KHTML, like Gecko)'",
  },
  {
    id: '01J0000000000000000000EDG2',
    t: '14:26:58',
    src: 'directo',
    cls: 'bot',
    why: '<img src=x onerror=alert(1)>',
  },
];
