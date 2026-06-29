// Ambient module typing for CSS Modules imported from the stage renderer.
//
// NOTE: src/renderer/global.d.ts also declares this wildcard, but that file is a
// *module* (it has top-level imports / `export {}`), so its `declare module
// '*.module.css'` is treated as a module-augmentation candidate rather than a
// global pattern-ambient module and never matches our relative `./Foo.module.css`
// imports. This file is a plain ambient declaration (no imports / exports), so its
// wildcard resolves CSS Module imports across the project.

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

// Vite's `?worker&url` import: bundles the entry into a transpiled JS asset and
// yields its URL string. Lives here (plain ambient file) for the same reason as
// the CSS Module wildcard above — global.d.ts is a module and won't match it.
declare module '*?worker&url' {
  const url: string;
  export default url;
}
