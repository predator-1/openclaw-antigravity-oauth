// Module resolve hook used only by the test suite (see ../setup.mjs).
const STUBS = {
  "openclaw/plugin-sdk/media-understanding": new URL("./media-understanding.mjs", import.meta.url).href
};

// Sync so the same export works with registerHooks() (required) and register().
export function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) {
    return { url: stub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
