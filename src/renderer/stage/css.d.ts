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
