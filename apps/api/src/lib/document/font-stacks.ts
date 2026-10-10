// Default CSS font-family stacks embedded in every exported document's <style>: a primary
// bundled family plus system fallbacks. A different fact from the EIGEN_FONTS registry (a bare
// family list) and from getFontCSS's @font-face embedding — the doc export resolves
// `var(--font-sans)` / `var(--font-mono)` to these before WeasyPrint runs. Kept byte-exact;
// the export goldens pin the rendered output.
export const FONT_STACK_SANS = '"Inter", system-ui, -apple-system, sans-serif';
export const FONT_STACK_MONO = '"JetBrains Mono", "Courier New", monospace';
