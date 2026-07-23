import { z } from 'zod';

// T6.4.1 — the classification vocabulary the honesty primitives (S6.4)
// render and the events_classified SQL view (E4) emit. Kept here, in
// contracts, so the UI and the view's rule table (design spec §7.1) share
// one vocabulary — a verdict the view can never actually return (there
// are exactly these four, resolved by two parallel CASE expressions over
// the same ordered rules) has no way to silently appear in the UI, and
// vice versa.
export const zClasificacion = z.enum(['humano', 'bot', 'unfurler', 'prefetch']);
export type Clasificacion = z.infer<typeof zClasificacion>;

// SourcePlatform: the worker's enrichment step (E3) derives this from
// referer + UA. `directo` is both a real value (no referer at all) and
// the fallback for anything the worker doesn't yet recognize (T6.4.9) —
// a SourceChip never renders blank.
export const zSourcePlatform = z.enum(['Instagram', 'WhatsApp', 'TikTok', 'directo']);
export type SourcePlatform = z.infer<typeof zSourcePlatform>;
