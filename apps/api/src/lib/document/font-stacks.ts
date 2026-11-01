// The CSS font-family stacks of an exported document, the same the editor draws in: a bundled family, then the
// emoji and CJK faces, then system fallbacks. The doc export puts them in place of the editor's `var(--font-sans)`
// and `var(--font-mono)` before WeasyPrint runs, and other exports, such as the sheet and canvas ones, set their body
// in the sans one. Each family's name sits beside its stack, for an export that lists the families it embeds.

import { getFontFamily } from '@workspace/lib/constants/fonts';

export const SANS_FONT_NAME = 'Inter';
export const MONO_FONT_NAME = 'JetBrains Mono';
export const FONT_STACK_SANS = getFontFamily(SANS_FONT_NAME);
export const FONT_STACK_MONO = getFontFamily(MONO_FONT_NAME);
