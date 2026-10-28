// The docx writer's table of contents: Word's TOC field in its gallery's content control, one paragraph per entry, and
// the bookmark on each heading that its entry links to. The entries come from the body's stored JSON through the
// outline's one rule, so they are the ones the editor and the PDF list. They hold no page numbers, so the field is
// marked dirty and Word fills them in when it updates the field.

import type { JSONContent } from '@tiptap/core';
import type { OutlineEntry } from '@workspace/lib/docs/eigendoc';
import { outlineEntry, PROSE_TEXTBLOCKS, readTocLevels } from '@workspace/lib/docs/eigendoc';
import { NO_TOC_ENTRIES, TOC_GALLERY, tocBookmark, tocInstruction } from '../../../ooxml/wordml';
import type { Context } from './package';
import type { Block, Paragraph } from './paragraphs';
import { fieldEnd, fieldStart, textXml } from './runs';

// The body's outline: its entries in document order, and each heading's number in it, from 1, by its JSON node.
export type DocxOutline = { entries: OutlineEntry[]; numbers: Map<JSONContent, number> };

// readOutline's walk over the stored JSON: into every block but a textblock, which holds no heading. Empty for a body
// with no table of contents, whose headings then take no bookmarks, as in Word.
export function docxOutline(body: JSONContent): DocxOutline {
    const outline: DocxOutline = { entries: [], numbers: new Map() };
    let listed = false;
    const walk = (node: JSONContent) => {
        listed ||= node.type === 'tableOfContents';
        const entry = node.type === 'heading' && outlineEntry(node.attrs?.['level'], node.content ?? []);
        if (entry) outline.numbers.set(node, outline.entries.push(entry));
        if (PROSE_TEXTBLOCKS.includes(node.type ?? '') || node.type === 'codeBlock') return;
        for (const child of node.content ?? []) walk(child);
    };
    for (const child of body.content ?? []) walk(child);
    return listed ? outline : { entries: [], numbers: new Map() };
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

// One paragraph per entry in Word's `toc N` style, its text a link to the heading and its page number a PAGEREF field
// after a dotted right tab at the column's edge. The first entry opens the TOC field and a last paragraph ends it.
export function tableOfContentsBlocks(node: JSONContent, context: Context): Block[] {
    const levels = readTocLevels(node.attrs?.['levels']);
    const tab = context.column;
    const entries: Paragraph[] = context.pkg.outline.entries.flatMap(({ level, text }, index) => {
        if (level > levels) return [];
        const name = tocBookmark(index + 1);
        const page = fieldStart(`PAGEREF ${name} \\h`) + fieldEnd();
        const runs = `<w:hyperlink w:anchor="${name}" w:history="1"><w:r>${textXml(text)}</w:r><w:r><w:tab/></w:r>${page}</w:hyperlink>`;
        return [{ props: { style: `TOC${level}`, rightTab: tab }, runs }];
    });
    const open = fieldStart(tocInstruction(levels), { dirty: true });
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
