// The CSS font-family stacks of every exported document: a bundled family, then system fallbacks. The doc export puts
// them in place of the editor's `var(--font-sans)` and `var(--font-mono)` before WeasyPrint runs. They are a different
// fact from the font registry's family names and from the embedded @font-face rules.

export const FONT_STACK_SANS = '"Inter", system-ui, -apple-system, sans-serif';
export const FONT_STACK_MONO = '"JetBrains Mono", "Courier New", monospace';
