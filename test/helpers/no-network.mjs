// Imported by the test helpers: the global fetch fails loudly, so code that does not use the injected
// deps.fetch (or a fake) can never reach Sveve, Google, Instagram or Netlify from a test.
globalThis.fetch = async (input) => {
  throw new Error(`Network is disabled in tests (global fetch called for ${String(input && input.url ? input.url : input)})`);
};
