// Found missing during T6.3.6: without this file, Next.js's CSS pipeline
// never invokes Tailwind's PostCSS plugin at all — the @tailwind
// directives in globals.css would compile to nothing. ESM export (not
// `module.exports`): the root ESLint flat config doesn't define Node's
// CommonJS globals for plain .js files, matching how .dependency-
// cruiser.js and eslint.config.js already do this in this repo. Next.js's
// config loader accepts either module format.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
