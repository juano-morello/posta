import { describe, expect, it } from 'vitest';
import {
  EDGE_CASE_HUMANO_BAR_SPLITS,
  EDGE_CASE_RECEIPTS,
  GALLERY_LINKS,
  GALLERY_RECEIPTS,
  GALLERY_SPLIT,
  zGalleryLink,
  zGalleryRecibo,
  zGallerySplit,
} from './fixtures';

// T6.5.2 — the single place gallery data comes from, so no entry ever
// reaches for a live endpoint. Every fixture must actually parse against
// its schema — a fixture that silently drifted out of shape would be
// exactly the kind of gallery bug nobody notices until a real screen
// tries to reuse the same shape in E7/E8.
describe('gallery fixtures (T6.5.2)', () => {
  it('every GALLERY_LINKS entry parses against zGalleryLink', () => {
    expect(GALLERY_LINKS.length).toBeGreaterThan(0);
    for (const link of GALLERY_LINKS) {
      expect(zGalleryLink.safeParse(link).success).toBe(true);
    }
  });

  it('every GALLERY_RECEIPTS entry parses against zGalleryRecibo (real contracts enums)', () => {
    expect(GALLERY_RECEIPTS.length).toBeGreaterThan(0);
    for (const receipt of GALLERY_RECEIPTS) {
      expect(zGalleryRecibo.safeParse(receipt).success).toBe(true);
    }
  });

  it('GALLERY_SPLIT parses against zGallerySplit', () => {
    expect(zGallerySplit.safeParse(GALLERY_SPLIT).success).toBe(true);
  });

  it('rejects a fixture with an invalid classification (regression guard on the real enum)', () => {
    const invalid = { ...GALLERY_RECEIPTS[0]!, cls: 'not-a-real-verdict' };
    expect(zGalleryRecibo.safeParse(invalid).success).toBe(false);
  });
});

// T6.5.6 — the honesty primitives' own edge cases, still real fixtures
// (not inline literals scattered across the gallery page), so they too
// go through the same schema gate as everything else here.
describe('gallery edge-case fixtures (T6.5.6)', () => {
  it('every EDGE_CASE_HUMANO_BAR_SPLITS entry parses against zGallerySplit', () => {
    const splits = Object.values(EDGE_CASE_HUMANO_BAR_SPLITS);
    expect(splits.length).toBe(4);
    for (const split of splits) {
      expect(zGallerySplit.safeParse(split).success).toBe(true);
    }
  });

  it('every EDGE_CASE_RECEIPTS entry parses against zGalleryRecibo', () => {
    expect(EDGE_CASE_RECEIPTS.length).toBe(2);
    for (const receipt of EDGE_CASE_RECEIPTS) {
      expect(zGalleryRecibo.safeParse(receipt).success).toBe(true);
    }
  });
});
