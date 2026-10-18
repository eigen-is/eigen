import {
    DOCUMENT_FONT,
    DOCUMENT_FONT_SIZE,
    EIGEN_FONT_NAMES,
    getFontFamily,
    readFontSize,
} from '../../constants/fonts';
import { cssLineHeight, DOCUMENT_PARAGRAPH_FORMAT, readParagraphFormat } from './nodes/paragraph-format';

// The doc's Normal text, which text without a font, size or colour mark and a paragraph without a format draws: a
// bundled font's name, the size and spacing in pt, line spacing a multiple, as a paragraph's.
export type NormalStyle = {
    font: string;
    size: number;
    lineSpacing: number;
    spaceBefore: number;
    spaceAfter: number;
    color: string;
};

// Eigen's own look, eigen-prose.css's fallbacks, which looks.test.ts holds together.
export const DEFAULT_NORMAL_STYLE: NormalStyle = {
    font: DOCUMENT_FONT,
    size: DOCUMENT_FONT_SIZE,
    lineSpacing: DOCUMENT_PARAGRAPH_FORMAT.lineSpacing,
    spaceBefore: DOCUMENT_PARAGRAPH_FORMAT.spaceBefore,
    spaceAfter: DOCUMENT_PARAGRAPH_FORMAT.spaceAfter,
    color: '#1a1a2e',
};

// The doc's Y.Map root holding its Normal, one key per field of NormalStyle, so two people changing two of them merge.
export const STYLE_ROOT = 'style';

const HEX_COLOR = /^#[0-9a-f]{6}$/;

// The one reader of a stored Normal (callers pass `map.toJSON()`): any peer writes the map, and the values reach CSS,
// so each key is read as a run's size and a paragraph's format are, and a font or colour only from the vocabulary.
export function readNormalStyle(record: Record<string, unknown>): NormalStyle {
    const { font, color } = record;
    const { lineSpacing, spaceBefore, spaceAfter } = readParagraphFormat(record);
    return {
        font: typeof font === 'string' && EIGEN_FONT_NAMES.includes(font) ? font : DEFAULT_NORMAL_STYLE.font,
        size: readFontSize(record['size']) ?? DEFAULT_NORMAL_STYLE.size,
        lineSpacing: lineSpacing ?? DEFAULT_NORMAL_STYLE.lineSpacing,
        spaceBefore: spaceBefore ?? DEFAULT_NORMAL_STYLE.spaceBefore,
        spaceAfter: spaceAfter ?? DEFAULT_NORMAL_STYLE.spaceAfter,
        color: typeof color === 'string' && HEX_COLOR.test(color) ? color : DEFAULT_NORMAL_STYLE.color,
    };
}

// The custom properties eigen-prose.css draws the body text from, set on the page: only those apart from Eigen's, so a
// doc that keeps Eigen's look renders exactly as one without the map.
export function normalStyleProperties(style: NormalStyle): Record<string, string> {
    const properties: Record<string, string> = {};
    const own = (key: keyof NormalStyle) => style[key] !== DEFAULT_NORMAL_STYLE[key];
    if (own('font')) properties['--doc-font-family'] = getFontFamily(style.font);
    if (own('size')) properties['--doc-font-size'] = `${style.size}pt`;
    if (own('lineSpacing')) properties['--doc-line-height'] = String(cssLineHeight(style.lineSpacing));
    if (own('spaceBefore')) properties['--doc-space-before'] = `${style.spaceBefore}pt`;
    if (own('spaceAfter')) properties['--doc-space-after'] = `${style.spaceAfter}pt`;
    if (own('color')) properties['--doc-color'] = style.color;
    return properties;
}
