export { getDocExtensions } from './extensions';
export { CommentMarkSchema } from './nodes/comment-mark';
export type { FigureAttrs, FigureLayout } from './nodes/figure';
export { FigureNode } from './nodes/figure';

// A4 page width at 96dpi — the intrinsic layout width of an eigendoc page.
export const A4_WIDTH_PX = 794;
// The page's p-[2cm] padding at 96dpi.
export const PAGE_MARGIN_PX = 75.6;
