// happy-dom (used by `@vitest-environment happy-dom` in renderer tests)
// does not implement `Element.prototype.scrollIntoView`. Renderer code
// calls it in normal effects (e.g. SearchableList active-row tracking),
// so without a stub those effects throw inside React's commit phase.
// Stubbing here keeps the production call unguarded — guarding scroll-
// IntoView in source would be test-shaped noise leaking into runtime.
if (typeof globalThis.Element !== "undefined" && !globalThis.Element.prototype.scrollIntoView) {
  globalThis.Element.prototype.scrollIntoView = function (): void {};
}
