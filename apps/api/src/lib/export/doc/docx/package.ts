// The docx writer's document frame: the part's namespaces, its section, its settings and the notes' separators, and the
// state one export carries as it walks the doc.

import type { JSONContent } from '@tiptap/core';
import type { NormalStyle, PageSetup } from '@workspace/lib/docs/eigendoc';
import type { CodeHighlighter } from '../../../document/lowlight';
import type { Lost } from '../../../document/transform/protocol';
import { A_NS, M_NS, MC_NS, PIC_NS, R_NS, W_NS, W14_NS, WP_NS, WPS_NS } from '../../../ooxml/ooxml';
import type { PartRelationships } from '../../../ooxml/opc';
import type { NOTE_SEPARATORS, StyleId } from '../../../ooxml/wordml';
import { SINGLE_LINE, WEB_VIEW, WORD_SETTINGS_URI } from '../../../ooxml/wordml';
import type { OfficeCharts } from '../../office-chart';
import type { OfficeImages } from '../../office-image';
import type { FontSlot } from './fonts';
import type { List } from './numbering';
import type { Block, NumberingRef } from './paragraphs';
import type { Styles } from './styles';

export const DOCUMENT_NAMESPACES = [
    `xmlns:w="${W_NS}"`,
    `xmlns:r="${R_NS}"`,
    `xmlns:wp="${WP_NS}"`,
    `xmlns:a="${A_NS}"`,
    `xmlns:pic="${PIC_NS}"`,
    `xmlns:wps="${WPS_NS}"`,
    `xmlns:w14="${W14_NS}"`,
    `xmlns:mc="${MC_NS}"`,
    `xmlns:m="${M_NS}"`,
    'mc:Ignorable="w14"',
].join(' ');

export const BAND_TAGS = { header: 'w:hdr', footer: 'w:ftr' } as const;

// What one export accumulates as it walks, each image file, shared bullet numbering and face once.
export type Package = {
    // The relationships of the part being written, the document's, a band's or the notes'.
    partRels: PartRelationships;
    publicOrigin: string | undefined;
    abstractNums: List[];
    // Each w:num's abstractNum, by index.
    numToAbstract: number[];
    bullets: Map<number, number>;
    checkboxes: boolean;
    languages: Set<string>;
    // The export's one highlighter, so its code blocks share one budget.
    highlight: CodeHighlighter;
    images: OfficeImages;
    // The charts the walk wrote, each part under word/charts/ and its workbook under word/embeddings/.
    charts: OfficeCharts;
    lastDrawingId: number;
    faces: Map<string, Set<FontSlot>>;
    // The notes the body references, note n at index n - 1.
    footnotes: JSONContent[];
    // The doc's Normal, which docDefaults and the Normal style write, and the styles built on it.
    normal: NormalStyle;
    styles: Styles;
    // The paper's width in twips, which a figure in front of or behind the text may span, and a page-less doc's table
    // column.
    paper: number;
    // A page-less doc, whose tables in the body keep their widths past the text column, as the editor draws them.
    pageless: boolean;
    // Counts what the docx leaves out or draws simpler, for the export's warnings.
    lost: Lost;
};

// The walk's surroundings, so a nested block sizes and indents itself against its parent: column and indent in twips.
export type Context = {
    pkg: Package;
    firstInFlow: boolean;
    // The type of the block after this one, which a numbered list runs on to when it is another.
    next?: string;
    column: number;
    indent: number;
    depth: number;
    // An untyped list numbers by how many ordered lists are around it.
    orderedListsAround: number;
    quotes: number;
    style?: StyleId;
    // The style TaskDone replaced, which an open task nested in a done one restores, as the editor strikes no nested task.
    undone?: StyleId;
    after?: number;
    align?: string;
    list?: NumberingRef;
    // The size of the heading or title around the run, which an inline code's em is of.
    blockPt?: number;
    // In a node that draws italic, which draws an italic mark upright.
    upright?: boolean;
    // In the body or a list or quote in it, where a figure keeps its place in front of or behind the text. A table cell,
    // a note and a band draw one in line.
    positions?: true;
    // An item's first paragraph, which takes the item's number and Word's list indent in place of its own.
    numbered?: true;
};

export function sectionXml(
    { width, height, margin, headerDistance, footerDistance, differentFirstPage }: PageSetup,
    references: string,
): string {
    const orient = width > height ? ' w:orient="landscape"' : '';
    const titlePg = differentFirstPage ? '<w:titlePg/>' : '';
    return `<w:sectPr>${references}<w:pgSz w:w="${width}" w:h="${height}"${orient}/><w:pgMar w:top="${margin.top}" w:right="${margin.right}" w:bottom="${margin.bottom}" w:left="${margin.left}" w:header="${headerDistance}" w:footer="${footerDistance}" w:gutter="0"/>${titlePg}</w:sectPr>`;
}

// Without the compatibility mode Word opens the file in Compatibility Mode. The fonts are embedded whole, so no subset flag.
// Word names the notes part's separators here. A page-less doc opens in Web Layout, where a wide table fits the window;
// w:view comes first, as CT_Settings orders its children and the writer writes no w:writeProtection.
export function settingsXml(footnotes: boolean, pageless: boolean): string {
    const separators = footnotes ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : '';
    const view = pageless ? `<w:view w:val="${WEB_VIEW}"/>` : '';
    return `<w:settings xmlns:w="${W_NS}">${view}<w:embedTrueTypeFonts/><w:defaultTabStop w:val="720"/>${separators}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="${WORD_SETTINGS_URI}" w:val="15"/></w:compat></w:settings>`;
}

// As Word writes them: single spaced with no space after, which Normal's spacing would add above the notes.
export function separatorXml(type: (typeof NOTE_SEPARATORS)[number], index: number): string {
    return `<w:footnote w:type="${type}" w:id="${index - 1}"><w:p><w:pPr><w:spacing w:after="0" w:line="${SINGLE_LINE}" w:lineRule="auto"/></w:pPr><w:r><w:${type}/></w:r></w:p></w:footnote>`;
}

// Word's number opens a note's first paragraph, then a space.
const NOTE_NUMBER =
    '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>';

export function withNoteNumber(blocks: Block[]): Block[] {
    const first = blocks.findIndex((block) => !('table' in block));
    if (first < 0) return [{ props: { style: 'FootnoteText' }, runs: NOTE_NUMBER }, ...blocks];
    return blocks.map((block, index) =>
        index === first && !('table' in block) ? { ...block, runs: NOTE_NUMBER + block.runs } : block,
    );
}
