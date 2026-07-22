// T6.1.12 — deliberately NOT 'use client'. theme.tsx (ThemeProvider/
// useTheme) is a Client Component module; every export of a 'use client'
// file becomes an opaque client reference under the RSC boundary, which
// cannot be *invoked* from a Server Component — only rendered as a
// component or passed through props. layout.tsx (a Server Component) needs
// to actually CALL themeInitScript() at render time to get its string, so
// this pure, React-free logic lives in its own plain module that both
// server and client code can import and call directly.
export const THEME_STORAGE_KEY = 'posta-theme';

// The exact source of the blocking <script> inlined into <head> (via
// dangerouslySetInnerHTML in layout.tsx). Plain synchronous script tags
// run before the rest of the document paints, so applying the stored
// class here — before React ever mounts — is what prevents a flash of
// the wrong theme. Dark is the fallback on any failure (empty storage,
// thrown access in e.g. Safari private mode): the try/catch is not
// decoration, it is the one thing standing between a storage read and a
// blank page. The catch still logs — a bare `catch(e){}` would make a
// real storage failure indistinguishable from "nothing was stored",
// which is exactly the kind of user-reported "theme keeps flashing" bug
// that is otherwise unreachable from server-side logs.
export function themeInitScript(): string {
  return (
    '(function(){try{' +
    `var t=window.localStorage.getItem('${THEME_STORAGE_KEY}');` +
    "if(t==='light'){document.documentElement.classList.add('light');}" +
    "}catch(e){console.warn('posta: theme init script could not read localStorage',e);}})();"
  );
}
