// The half of the formula package that reads and rewrites formula text and moves row and column indices, with no
// cell store and no function library, for callers that need nothing else.

export type { Edit, Span } from './edit/map';
export { GONE, mapIndex, mapSpan } from './edit/map';
