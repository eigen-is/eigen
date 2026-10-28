// The facts about a Docs heading that more than the editor reads, such as the deepest level and the levels drawn in
// italic. The outline, a table of contents and the exports read them from here.

// Headings run from level 1 to this, as in Word and Google Docs.
export const MAX_HEADING_LEVEL = 6;

// The heading levels eigen-prose.css sets in italic, Heading 6 as in Google Docs; an italic mark in one draws upright.
export const ITALIC_HEADING_LEVELS: ReadonlySet<number> = new Set([6]);

// Their tags as one selector, `:not(*)` for none, as querySelectorAll('') throws.
export const ITALIC_HEADING_SELECTOR = [...ITALIC_HEADING_LEVELS].map((level) => `h${level}`).join(', ') || ':not(*)';
