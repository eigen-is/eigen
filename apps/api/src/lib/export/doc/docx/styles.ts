import { DOCUMENT_LINE_RATIO, fontLineHeight } from '@workspace/lib/constants/fonts';
import type { NormalStyle } from '@workspace/lib/docs/eigendoc';
import { cssColorToHex } from '../../../document/colors';
import {
    BODY,
    boxSide,
    CAPTION_LOOK,
    CODE_BLOCK_LOOK,
    CODE_LOOK,
    cssPt,
    FOOTNOTE_LOOK,
    HEADING_LOOKS,
    halfPoints,
    LINK_LOOK,
    proseBorder,
    proseColor,
    QUOTE_LOOK,
    TASK_DONE_LOOK,
    TITLE_LOOKS,
    TITLE_SELECTORS,
    twips,
} from '../../../document/looks';
import { proseValue, proseValueIfSet } from '../../../document/prose-css';
import { W_NS } from '../../../ooxml/ooxml';
import type { StyleId } from '../../../ooxml/wordml';
import { codeBlockStyle, headingStyleName, JUSTIFICATION, STYLE_NAMES } from '../../../ooxml/wordml';
import type { Package } from './package';
import type { ParagraphProps } from './paragraphs';
import { pPrXml, TITLE_STYLES } from './paragraphs';
import type { RunProps } from './runs';
import { rPrXml } from './runs';

// Styles, every value from eigen-prose.css.

function lineHeightPt(value: string, sizePt: number): number {
    return /^[\d.]+$/.test(value) ? Number(value) * sizePt : cssPt(value, sizePt);
}

// A multiple of the font's own line height, so the pitch is the CSS one: Google Docs reads every atLeast as single.
function autoLine(linePt: number, sizePt: number, font: string): number {
    return Math.round((240 * linePt) / (sizePt * fontLineHeight(font)));
}

// A line spacing, which CSS draws in Inter's line, in the Normal's font, as Word draws it.
export function normalLine(lineSpacing: number, normal: NormalStyle): number {
    return autoLine(lineSpacing * DOCUMENT_LINE_RATIO * normal.size, normal.size, normal.font);
}

// A length an element in the body text takes, in twips.
export function proseTwips(selector: string, property: string): number {
    return twips(cssPt(proseValue(selector, property), BODY.sizePt));
}

// A heading or title without its own size or line height inherits the prose root's, as h5 and h6 do: its size the
// Normal's.
export function textMetrics(selector: string, normalPt: number) {
    const size = proseValueIfSet(selector, 'font-size');
    const sizePt = size === undefined ? normalPt : cssPt(size, BODY.sizePt);
    const line = proseValueIfSet(selector, 'line-height') ?? proseValue('.eigen-prose', 'line-height');
    const tracking = proseValueIfSet(selector, 'letter-spacing');
    return {
        sizePt,
        before: twips(cssPt(proseValue(selector, 'margin-top'), sizePt)),
        after: twips(cssPt(proseValue(selector, 'margin-bottom'), sizePt)),
        line: lineHeightPt(line, sizePt),
        tracking: tracking === undefined ? undefined : twips(cssPt(tracking, sizePt)),
    };
}

export type Styles = Map<StyleId, StyleDef>;

export type StyleDef = {
    type: 'paragraph' | 'character' | 'table' | 'numbering';
    id: StyleId;
    name: string;
    isDefault?: true;
    basedOn?: StyleId;
    next?: StyleId;
    uiPriority?: number;
    semiHidden?: true;
    unhideWhenUsed?: true;
    qFormat?: true;
    pPr?: ParagraphProps;
    rPr?: RunProps;
    tblPr?: string;
};

function styleXml(style: StyleDef): string {
    const {
        type,
        id,
        name,
        isDefault,
        basedOn,
        next,
        uiPriority,
        semiHidden,
        unhideWhenUsed,
        qFormat,
        pPr,
        rPr,
        tblPr,
    } = style;
    return [
        `<w:style w:type="${type}"${isDefault ? ' w:default="1"' : ''} w:styleId="${id}"><w:name w:val="${name}"/>`,
        basedOn && `<w:basedOn w:val="${basedOn}"/>`,
        next && `<w:next w:val="${next}"/>`,
        uiPriority !== undefined && `<w:uiPriority w:val="${uiPriority}"/>`,
        semiHidden && '<w:semiHidden/>',
        unhideWhenUsed && '<w:unhideWhenUsed/>',
        qFormat && '<w:qFormat/>',
        pPr && `<w:pPr>${pPrXml(pPr)}</w:pPr>`,
        rPr && `<w:rPr>${rPrXml(rPr)}</w:rPr>`,
        tblPr,
        '</w:style>',
    ]
        .filter(Boolean)
        .join('');
}

// A 1 pt line for paragraphs that hold no text of their own: a bare one is a full Normal line.
export const HAIRLINE_TWIPS = 20;

const HAIRLINE: Pick<StyleDef, 'pPr' | 'rPr'> = {
    pPr: { spacing: { before: 0, after: 0, line: HAIRLINE_TWIPS, exact: true } },
    rPr: { size: 2 },
};

// No w:lang, so Word checks spelling in the reader's own language. Text without a font, colour or size draws in the
// Normal's.
export function stylesXml({ normal, styles, languages }: Package): string {
    const run = { font: normal.font, color: cssColorToHex(normal.color), size: halfPoints(normal.size) };
    const defaults = `<w:docDefaults><w:rPrDefault><w:rPr>${rPrXml(run)}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${pPrXml({ spacing: { before: 0, after: 0 } })}</w:pPr></w:pPrDefault></w:docDefaults>`;
    // Without unhideWhenUsed a language's style stays out of the gallery once used.
    const variants = [...languages].map(
        (language): StyleDef => ({
            type: 'paragraph',
            ...codeBlockStyle(language),
            basedOn: 'CodeBlock',
            semiHidden: true,
        }),
    );
    return `<w:styles xmlns:w="${W_NS}">${defaults}${[...styles.values(), ...variants].map(styleXml).join('')}</w:styles>`;
}

// Built per export on the doc's Normal. A quote's paragraphs take none of its space before, as the editor draws them.
export function styleDefinitions(normal: NormalStyle): StyleDef[] {
    const before = normal.spaceBefore > 0 ? { before: 0 } : {};
    const codePt = cssPt(proseValue('.eigen-prose pre code', 'font-size'), BODY.sizePt);
    const codeMargin = proseValue('.eigen-prose pre', 'margin');
    const rule = { ...proseBorder('.eigen-prose hr', 'border-top'), space: 1 };
    const ruleMargin = proseValue('.eigen-prose hr', 'margin');
    const titles = TITLE_STYLES.map(({ type, id, uiPriority }): StyleDef => {
        const { sizePt, before, after, line, tracking } = textMetrics(TITLE_SELECTORS[type], normal.size);
        return {
            type: 'paragraph',
            id,
            name: STYLE_NAMES[id],
            basedOn: 'Normal',
            next: 'Normal',
            uiPriority,
            qFormat: true,
            pPr: {
                keepNext: true,
                keepLines: true,
                spacing: { before, after, line: autoLine(line, sizePt, normal.font) },
            },
            rPr: { spacing: tracking, size: halfPoints(sizePt), ...TITLE_LOOKS[type] },
        };
    });
    const headings = HEADING_LOOKS.map((look, index): StyleDef => {
        const level = index + 1;
        const { sizePt, before, after, line, tracking } = textMetrics(`.eigen-prose h${level}`, normal.size);
        return {
            type: 'paragraph',
            id: `Heading${level}`,
            name: headingStyleName(level),
            basedOn: 'Normal',
            next: 'Normal',
            uiPriority: 9,
            qFormat: true,
            pPr: {
                keepNext: true,
                keepLines: true,
                spacing: { before, after, line: autoLine(line, sizePt, normal.font) },
                outlineLvl: level - 1,
            },
            rPr: { spacing: tracking, size: halfPoints(sizePt), ...look },
        };
    });
    return [
        {
            type: 'paragraph',
            id: 'Normal',
            name: STYLE_NAMES.Normal,
            isDefault: true,
            qFormat: true,
            pPr: {
                spacing: {
                    before: normal.spaceBefore > 0 ? twips(normal.spaceBefore) : undefined,
                    after: twips(normal.spaceAfter),
                    line: normalLine(normal.lineSpacing, normal),
                },
            },
        },
        {
            type: 'character',
            id: 'DefaultParagraphFont',
            name: STYLE_NAMES.DefaultParagraphFont,
            isDefault: true,
            uiPriority: 1,
            semiHidden: true,
            unhideWhenUsed: true,
        },
        {
            type: 'table',
            id: 'TableNormal',
            name: STYLE_NAMES.TableNormal,
            isDefault: true,
            uiPriority: 99,
            semiHidden: true,
            unhideWhenUsed: true,
            tblPr: '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>',
        },
        {
            type: 'numbering',
            id: 'NoList',
            name: STYLE_NAMES.NoList,
            isDefault: true,
            uiPriority: 99,
            semiHidden: true,
            unhideWhenUsed: true,
        },
        ...titles,
        ...headings,
        {
            type: 'paragraph',
            id: 'Quote',
            name: STYLE_NAMES.Quote,
            basedOn: 'Normal',
            qFormat: true,
            pPr: {
                pBdr: { left: QUOTE_LOOK.border },
                spacing: {
                    ...before,
                    after: twips(
                        cssPt(boxSide(proseValue('.eigen-prose blockquote p', 'margin'), 'bottom'), BODY.sizePt),
                    ),
                },
                ind: { left: QUOTE_LOOK.indent },
            },
            rPr: { italic: QUOTE_LOOK.italic || undefined, color: QUOTE_LOOK.color },
        },
        {
            type: 'paragraph',
            id: 'CodeBlock',
            name: STYLE_NAMES.CodeBlock,
            basedOn: 'Normal',
            pPr: {
                pBdr: CODE_BLOCK_LOOK.borders,
                shading: CODE_BLOCK_LOOK.fill,
                spacing: {
                    before: twips(cssPt(boxSide(codeMargin, 'top'), BODY.sizePt)),
                    after: twips(cssPt(boxSide(codeMargin, 'bottom'), BODY.sizePt)),
                    line: autoLine(
                        lineHeightPt(proseValue('.eigen-prose pre', 'line-height'), codePt),
                        halfPoints(codePt) / 2,
                        CODE_LOOK.font,
                    ),
                },
                ind: { left: CODE_BLOCK_LOOK.indent, right: CODE_BLOCK_LOOK.indent },
                // Only the box's ends take the margin, and the lines' borders merge into one box.
                contextualSpacing: true,
            },
            rPr: {
                font: CODE_LOOK.font,
                color: proseColor('.eigen-prose pre code', 'color'),
                size: halfPoints(codePt),
            },
        },
        {
            type: 'paragraph',
            id: 'Caption',
            name: STYLE_NAMES.Caption,
            basedOn: 'Normal',
            next: 'Normal',
            qFormat: true,
            pPr: {
                spacing: {
                    before: twips(cssPt(proseValue('.eigen-prose figcaption', 'margin-top'), CAPTION_LOOK.sizePt)),
                    after: twips(cssPt(boxSide(proseValue('.eigen-prose figure', 'margin'), 'bottom'), BODY.sizePt)),
                },
                jc: JUSTIFICATION.get(proseValue('.eigen-prose figcaption', 'text-align')),
            },
            rPr: { color: CAPTION_LOOK.color, size: halfPoints(CAPTION_LOOK.sizePt) },
        },
        {
            type: 'paragraph',
            id: 'HorizontalRule',
            name: STYLE_NAMES.HorizontalRule,
            basedOn: 'Normal',
            pPr: {
                pBdr: { bottom: rule },
                spacing: {
                    ...HAIRLINE.pPr?.spacing,
                    before: twips(cssPt(boxSide(ruleMargin, 'top'), BODY.sizePt)),
                    after: twips(cssPt(boxSide(ruleMargin, 'bottom'), BODY.sizePt)),
                },
            },
            rPr: HAIRLINE.rPr,
        },
        { type: 'paragraph', id: 'PageBreak', name: STYLE_NAMES.PageBreak, basedOn: 'Normal', ...HAIRLINE },
        { type: 'paragraph', id: 'Spacer', name: STYLE_NAMES.Spacer, basedOn: 'Normal', ...HAIRLINE },
        {
            type: 'paragraph',
            id: 'TaskDone',
            name: STYLE_NAMES.TaskDone,
            basedOn: 'Normal',
            rPr: { strike: TASK_DONE_LOOK.strike || undefined, color: TASK_DONE_LOOK.color },
        },
        // Word's own, which Google's notes take too: 10 pt, single spaced, no space after, the number superscript.
        {
            type: 'paragraph',
            id: 'FootnoteText',
            name: STYLE_NAMES.FootnoteText,
            basedOn: 'Normal',
            uiPriority: 99,
            semiHidden: true,
            unhideWhenUsed: true,
            pPr: { spacing: { after: 0, line: 240 } },
            rPr: { size: halfPoints(FOOTNOTE_LOOK.sizePt) },
        },
        {
            type: 'character',
            id: 'FootnoteReference',
            name: STYLE_NAMES.FootnoteReference,
            basedOn: 'DefaultParagraphFont',
            uiPriority: 99,
            semiHidden: true,
            unhideWhenUsed: true,
            rPr: { vertAlign: 'superscript' },
        },
        {
            type: 'character',
            id: 'Hyperlink',
            name: STYLE_NAMES.Hyperlink,
            basedOn: 'DefaultParagraphFont',
            uiPriority: 99,
            rPr: { color: LINK_LOOK.color },
        },
        {
            type: 'character',
            id: 'Code',
            name: STYLE_NAMES.Code,
            basedOn: 'DefaultParagraphFont',
            rPr: {
                font: CODE_LOOK.font,
                color: CODE_LOOK.color,
                size: halfPoints(CODE_LOOK.sizePt),
                shading: CODE_LOOK.shading,
            },
        },
    ];
}
