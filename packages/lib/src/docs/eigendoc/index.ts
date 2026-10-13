export { getDocExtensions, PROSE_TEXTBLOCKS } from './extensions';
export { ITALIC_HEADING_LEVELS, ITALIC_HEADING_SELECTOR } from './heading';
export type { Caps } from './nodes/caps';
export { CommentMarkSchema } from './nodes/comment-mark';
export type { FigureAttrs } from './nodes/figure';
export { FigureNode, readFigureAttrs } from './nodes/figure';
export type { FigureAlignment, FigureFrameAttrs, FigureLayout } from './nodes/figure-frame';
export { readFigureFrameAttrs, setFigureAttributes } from './nodes/figure-frame';
export { PAGE_BREAK_CLASS } from './nodes/page-break';
export type { TitleType } from './nodes/title';
export type { PageMargin, PageSetup, PaperSizeName } from './page';
export {
    DEFAULT_PAGE_SETUP,
    MIN_TEXT_MM,
    matchPaperSize,
    PAGE_ROOT,
    PAPER_SIZES,
    pageBoxStyle,
    pagePx,
    pageRecord,
    pageStylesheet,
    pageTwips,
    readPageSetup,
} from './page';
export { MIN_TABLE_COLUMN_PX } from './table';
