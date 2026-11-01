// The CSS font-family stacks of every exported document, the same the editor draws in: a bundled family, then the
// emoji and CJK faces, then system fallbacks. The doc export puts them in place of the editor's `var(--font-sans)`
// and `var(--font-mono)` before WeasyPrint runs, and the sheet and canvas exports set their body in the sans one.

import { getFontFamily } from '@workspace/lib/constants/fonts';

export const FONT_STACK_SANS = getFontFamily('Inter');
export const FONT_STACK_MONO = getFontFamily('JetBrains Mono');
