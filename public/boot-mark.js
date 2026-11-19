/*
 * When the control page began to parse (issue #240). A classic script, first
 * in <head>, so it runs before the module graph is even requested: the time
 * from here to the first statement of src/control/main.ts is fetching,
 * parsing and evaluating the control bundle, measured from a point that does
 * not depend on when WebKit stamps navigation start (bench/perf/README.md).
 *
 * Not a module and not inline: the CSP allows only same-origin scripts, and a
 * module would be deferred behind the parse it is meant to mark. One
 * assignment, in every build; only the benchmark build reads it.
 */
window.__SPEAKING_GLASS_BOOT__ = performance.now();
