import type { UrlBuilders } from '@posta/contracts';
import { escapeHtml } from './escape-html';

// T2.5.2 — S2.5's 404 page: the ONE HTML document the API renders
// (CLAUDE.md invariant 11's single named exception). Every other page in
// this product is rendered by `web` (Next); this one lives in `api` and
// stays a template string with ZERO dependencies specifically BECAUSE it
// must still render when Next, Postgres, Redis and the queue are all
// down — a dead link's error page cannot itself depend on any of the
// things that could be the reason the link is dead. No framework, no
// build step, no runtime dependency, no external request of any kind
// (no external stylesheet, font, script or image — everything inline).
//
// Curried-factory shape — config resolved once at boot, the returned
// function runs per request — mirrors host.ts's makeRequestTargetParser
// and contracts/domain.ts's makeUrlBuilders itself (both in this same
// directory/package). renderNotFound cannot be a bare `renderNotFound
// (slug)` that reaches into process.env on its own: `packages/contracts`
// (where UrlBuilders lives) is isomorphic and has no env access of its
// own, and this file needs to stay unit-testable without a real
// process.env. `config.urls` carries the WHOLE UrlBuilders object, not
// just buildAppUrl narrowed out of it — matching host.ts's
// RequestTargetParserConfig precedent exactly, so a reader who has just
// read host.ts sees the identical shape here rather than a second,
// narrower convention invented just for this file.
//
// DESIGN.md §1's dark-island tokens (background #0D1117, surface
// #161B22, foreground #E6EDF3, muted-foreground #8B949E, border
// #30363D, error #F85149, lime primary #B4FF39) are written below as
// LITERAL HEX, never imported from any token/theme/Tailwind module. This
// is deliberate duplication, not an oversight: this file cannot reach
// the token pipeline (Tailwind config, generated CSS custom properties,
// any build step) because it must render with NONE of those available —
// the exact scenario a 404 page exists to survive. A future "DRY this
// up" pass must not import a shared token file here; that would make
// this page's ability to render depend on whatever built the token file,
// which is precisely the dependency this file exists to not have. Dark
// island styling applies UNCONDITIONALLY (DESIGN.md §1: terminal/code
// surfaces are never themed) — there is no light-mode branch anywhere in
// this template.

export interface NotFoundRendererConfig {
  /**
   * Built once at boot from validated env — see makeUrlBuilders
   * (packages/contracts/src/domain.ts). Only `buildAppUrl()` is actually
   * used here (the "quiet link home"); the whole UrlBuilders is accepted
   * anyway, matching host.ts's makeRequestTargetParser in this directory.
   */
  readonly urls: UrlBuilders;
}

export type RenderNotFound = (slug: string) => string;

const PAGE_TITLE = '404 · Posta';
const ERROR_LINE = 'error: no existe ese link';
const HOME_LINK_TEXT = 'volver a posta';

/**
 * Builds the 404 renderer from config resolved once at boot. The
 * returned function is what runs per request (T2.5.3 wires it into the
 * middleware's terminal branches — not this task).
 */
export function makeNotFoundRenderer(config: NotFoundRendererConfig): RenderNotFound {
  // Computed ONCE, not per request: buildAppUrl() takes no path argument
  // here and is fixed for the life of the process (config comes from
  // validated env, which cannot change at runtime) — same reasoning as
  // contracts/domain.ts's own top-of-file comment on why makeUrlBuilders'
  // derived strings are computed once and closed over, not recomputed on
  // every call.
  const homeUrl = config.urls.buildAppUrl();

  return function renderNotFound(slug: string): string {
    // The ONLY attacker-controlled value in this document — a 404 is
    // reached precisely because `slug` came from the request path and
    // did not resolve to a real link. escapeHtml (T2.5.1) is
    // interpolated into TEXT CONTENT only, exactly the context its own
    // docstring says it covers — never into an unquoted attribute, a URL,
    // or a <script> block, none of which it protects.
    const safeSlug = escapeHtml(slug);

    // Every rule below earns its place against the 4 KB whole-document
    // budget: one small reset, one card, one prompt style, one error
    // color, one cursor block, one keyframe, one link style, one media
    // query. No CSS reset framework, no unused selectors.
    //
    // prefers-reduced-motion: the blinking cursor is disabled (not just
    // slowed) under this query, and left visible at full opacity rather
    // than removed — a static lime block still reads as "this is a
    // terminal cursor", which is the point of the affordance, without
    // the motion that guideline exists to let a visitor opt out of. This
    // costs exactly one media query, which the 4 KB budget comfortably
    // affords; skipping it to save a few dozen bytes was not a trade
    // worth making.
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${PAGE_TITLE}</title>
<style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0D1117;color:#E6EDF3;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:15px;line-height:1.7;padding:24px}
main{width:100%;max-width:440px;background:#161B22;border:1px solid #30363D;border-radius:8px;padding:24px}
p{white-space:pre-wrap;word-break:break-word}
.prompt{color:#8B949E}
.err{color:#F85149;margin-top:8px}
.cursor{display:inline-block;width:.5em;height:1.05em;background:#B4FF39;vertical-align:text-bottom;animation:blink 1.1s steps(1,end) infinite}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
a{color:#8B949E;text-decoration:none;font-size:13px}
a:hover{color:#B4FF39;text-decoration:underline}
.home{display:block;margin-top:20px}
@media (prefers-reduced-motion:reduce){.cursor{animation:none;opacity:1}}
</style>
</head>
<body>
<main>
<p><span class="prompt">~/posta $</span> cd /${safeSlug}</p>
<p class="err">${ERROR_LINE}</p>
<p><span class="prompt">~/posta $</span> <span class="cursor"></span></p>
<a class="home" href="${homeUrl}">${HOME_LINK_TEXT}</a>
</main>
</body>
</html>`;
  };
}
