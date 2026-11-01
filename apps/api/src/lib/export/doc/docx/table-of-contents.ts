// The docx writer's table of contents: Word's TOC field in its gallery's content control, one paragraph per entry, and
// the bookmark on each heading that its entry links to. The entries come from the body's stored JSON through the
// outline's one rule, so they are the ones the editor and the PDF list. They hold no page numbers, so the field is
// marked dirty and Word fills them in when it updates the field. Word's toc 1 to toc 6 styles carry the first table of
// contents' look, as Word keeps a look there.

import type { JSONContent } from '@tiptap/core';
import type { OutlineEntry } from '@workspace/lib/docs/eigendoc';
import {
    MAX_HEADING_LEVEL,
    outlineEntry,
    PROSE_TEXTBLOCKS,
    readTocLayout,
    readTocLevelStyle,
    readTocLevels,
    TOC_LEVEL_KEYS,
} from '@workspace/lib/docs/eigendoc';
import { halfPoints } from '../../../document/looks';
import type { StyleId } from '../../../ooxml/wordml';
import { NO_TOC_ENTRIES, TOC_GALLERY, tocBookmark, tocInstruction } from '../../../ooxml/wordml';
import { useFace } from './fonts';
import type { Context } from './package';
import type { Block, Paragraph, RightTab } from './paragraphs';
import type { RunProps } from './runs';
import { fieldEnd, fieldStart, textXml } from './runs';

// The body's outline: its entries in document order, each heading's number in it, from 1, by its JSON node, and the
// body's first table of contents, whose look the toc styles take.
export type DocxOutline = { entries: OutlineEntry[]; numbers: Map<JSONContent, number>; first?: JSONContent };

// readOutline's walk over the stored JSON: into every block but a textblock, which holds no heading. Empty for a body
// with no table of contents, whose headings then take no bookmarks, as in Word.
export function docxOutline(body: JSONContent): DocxOutline {
    const outline: DocxOutline = { entries: [], numbers: new Map() };
    const walk = (node: JSONContent) => {
        if (node.type === 'tableOfContents') outline.first ??= node;
        const entry = node.type === 'heading' && outlineEntry(node.attrs?.['level'], node.content ?? []);
        if (entry) outline.numbers.set(node, outline.entries.push(entry));
        if (PROSE_TEXTBLOCKS.includes(node.type ?? '') || node.type === 'codeBlock') return;
        for (const child of node.content ?? []) walk(child);
    };
    for (const child of body.content ?? []) walk(child);
    return outline.first ? outline : { entries: [], numbers: new Map() };
}

// A heading's first paragraph holds its bookmark, as Word puts one around the heading's text.
export function withBookmark(blocks: Block[], number: number): Block[] {
    const first = blocks.findIndex((block) => !('table' in block));
    const name = tocBookmark(number);
    return blocks.map((block, index) =>
        index === first && !('table' in block)
            ? {
                  ...block,
                  runs: `<w:bookmarkStart w:id="${number}" w:name="${name}"/>${block.runs}<w:bookmarkEnd w:id="${number}"/>`,
              }
            : block,
    );
}

// One paragraph per entry in Word's `toc N` style, its text a link to the heading and, with page numbers, its page
// number a PAGEREF field after a right tab at the column's edge, which leads with the node's leader. The first entry
// opens the TOC field and a last paragraph ends it. The layout is the stored one whatever the doc's paper: Word always
// lays out pages, so a page-less doc, which draws Links, keeps its own facts for the import.
export function tableOfContentsBlocks(node: JSONContent, context: Context): Block[] {
    const attrs = node.attrs ?? {};
    const levels = readTocLevels(attrs['levels']);
    const { pageNumbers, leader } = readTocLayout(attrs);
    const rightTab: RightTab = { pos: context.column, leader };
    // The docx embeds the face of each level an entry draws in. It also embeds the face of a level whose style names a
    // font, with no entries, as an entry Word's update adds draws in it.
    const listed = new Set(context.pkg.outline.entries.flatMap(({ level }) => (level > levels ? [] : [level])));
    for (let level = 1; level <= MAX_HEADING_LEVEL; level++) {
        const style: StyleId = `TOC${level}`;
        if (listed.has(level) || context.pkg.styles.get(style)?.rPr?.font !== undefined)
            useFace(context.pkg, {}, style);
    }
    const entries: Paragraph[] = context.pkg.outline.entries.flatMap(({ level, text }, index) => {
        if (level > levels) return [];
        const name = tocBookmark(index + 1);
        const style: StyleId = `TOC${level}`;
        const page = pageNumbers ? `<w:r><w:tab/></w:r>${fieldStart(`PAGEREF ${name} \\h`)}${fieldEnd()}` : '';
        const runs = `<w:hyperlink w:anchor="${name}" w:history="1"><w:r>${textXml(text)}</w:r>${page}</w:hyperlink>`;
        return [{ props: { style, rightTab }, runs }];
    });
    const open = fieldStart(tocInstruction(levels, pageNumbers), { dirty: true });
    const [first = { props: {}, runs: `<w:r>${textXml(NO_TOC_ENTRIES)}</w:r>` }, ...rest] = entries;
    return [
        {
            ...first,
            opens: `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="${TOC_GALLERY}"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>`,
            runs: open + first.runs,
        },
        ...rest,
        { props: {}, runs: fieldEnd(), closes: '</w:sdtContent></w:sdt>' },
    ];
}

// What Word's toc 1 to toc 6 styles take from the body's first table of contents: each level's run properties, by
// level - 1, and the right tab when its leader is not the dots Word's own entries draw. Word's Update Table rewrites the
// entries in these styles, so their look survives it, and a second table of contents comes back with the first's.
export type TocStyleLook = { runs: readonly (RunProps | undefined)[]; tab?: RightTab };

// None for a body with no table of contents, or with one that lists nothing and has no look, as Word writes no toc
// styles then.
export function tocStyleLook(outline: DocxOutline, column: number): TocStyleLook | undefined {
    const attrs = outline.first?.attrs;
    if (!attrs) return undefined;
    // A false flag draws as the body text does, so it writes nothing, as the import reads nothing from none.
    const runs = TOC_LEVEL_KEYS.map((key): RunProps | undefined => {
        const look = readTocLevelStyle(attrs[key]);
        const run: RunProps = {
            ...(look?.font !== undefined && { font: look.font }),
            ...(look?.bold === true && { bold: true }),
            ...(look?.italic === true && { italic: true }),
            ...(look?.size !== undefined && { size: halfPoints(look.size) }),
        };
        return Object.keys(run).length > 0 ? run : undefined;
    });
    const { leader } = readTocLayout(attrs);
    const tab: RightTab | undefined = leader === 'none' ? { pos: column, leader } : undefined;
    if (outline.entries.length === 0 && !tab && runs.every((run) => run === undefined)) return undefined;
    return { runs, ...(tab && { tab }) };
}
