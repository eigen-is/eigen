// The docx writer's lists: a w:num per list and an abstractNum per ordered list, so lists side by side stay apart and
// count apart, and Word's checkbox for a task. The paragraph walker calls listOf and itemOf, and the package writes
// numbering.xml from what they recorded.

import type { JSONContent } from '@tiptap/core';
import { BLOCK_MARGINS, LIST_LEVEL, proseTwips } from '../../../document/looks';
import { W_NS } from '../../../ooxml/ooxml';
import { CHECKBOX_GLYPHS, LIST_LEVELS, SINGLE_LINE } from '../../../ooxml/wordml';
import type { Context, Package } from './package';
import type { Block, Paragraph, ParagraphProps } from './paragraphs';
import { blocksOf, indentOf, pPrXml, quoteBar, textProps, withAfter } from './paragraphs';
import { rPrXml } from './runs';

export type List = { format: string; start: number; base: number };

export const CLEAR_FLOATS = '<w:r><w:br w:type="textWrapping" w:clear="all"/></w:r>';

// Only an outermost list's last paragraph takes the list's margin; a task list and an empty one number nothing.
export function listOf(
    node: JSONContent,
    context: Context,
    tag: 'ul' | 'ol',
    numbering: Omit<List, 'base'> | undefined,
): Block[] {
    const ilvl = Math.min(context.depth, LIST_LEVELS - 1);
    const content = node.content ?? [];
    const list =
        numbering && content.some((item) => item.type === 'listItem')
            ? {
                  numId: numIdOf(context.pkg, {
                      ...numbering,
                      base: itemIndent(context) - LIST_LEVEL * (ilvl + 1),
                  }),
                  ilvl,
              }
            : undefined;
    const items = { ...context, list, orderedListsAround: context.orderedListsAround + (tag === 'ol' ? 1 : 0) };
    const blocks = blocksOf(content, textProps({}, items), items);
    if (context.depth > 0) return blocks;
    const runsOn = tag === 'ol' && context.next === 'orderedList';
    return withAfter(
        blocks,
        runsOn ? proseTwips('.eigen-prose ol:has(+ ol)', 'margin-bottom') : BLOCK_MARGINS[tag],
        context.pkg.styles,
    );
}

// Each list is a w:num of its own, so lists side by side stay apart; a bullet counts nothing, so bullet lists at one
// indent share their definition: Word caps the definitions a file holds.
function numIdOf(pkg: Package, list: List): number {
    const bullet = list.format === 'bullet';
    const abstract = (bullet ? pkg.bullets.get(list.base) : undefined) ?? pkg.abstractNums.push(list) - 1;
    if (bullet) pkg.bullets.set(list.base, abstract);
    return pkg.numToAbstract.push(abstract);
}

// The item's text is a level in; only its first paragraph opens with the number or checkbox.
export function itemOf(
    node: JSONContent,
    context: Context,
    after: number,
    open: (first: Paragraph, inner: Context) => Paragraph,
): Block[] {
    const inner: Context = {
        ...context,
        indent: itemIndent(context),
        depth: context.depth + 1,
        after,
        list: undefined,
        numbered: true,
    };
    const props = textProps({}, inner);
    const blocks = blocksOf(node.content ?? [], props, inner);
    // The first block past the floats takes the number, or an empty holder above it when it is no plain paragraph.
    const found = blocks.findIndex((block) => !('float' in block));
    const index = found === -1 ? blocks.length : found;
    const first = blocks[index];
    const opened =
        first && !('table' in first) && first.props.style === inner.style
            ? blocks.with(index, open(first, inner))
            : blocks.toSpliced(index, 0, open({ props, runs: '' }, inner));
    // The editor's item contains its floats: a clearing break starts the next item below them, on a single-spaced hairline.
    // A nested item clears its own, so only a float after the last clearing break is this item's to clear.
    const cleared = opened.findLastIndex((block) => !('table' in block) && block.runs === CLEAR_FLOATS);
    if (!opened.slice(cleared + 1).some((block) => 'table' in block && block.float)) return opened;
    const clearing: ParagraphProps = {
        style: 'Spacer',
        pBdr: quoteBar('Spacer', context),
        spacing: { after, line: SINGLE_LINE },
        ind: indentOf('Spacer', context),
    };
    return [...opened, { props: clearing, runs: CLEAR_FLOATS }];
}

// A list or quote deeper than Word's levels indents no further.
function itemIndent(context: Context): number {
    return context.indent + (context.depth < LIST_LEVELS ? LIST_LEVEL : 0);
}

export function numberingXml(lists: List[], numToAbstract: number[]): string {
    const abstractNums = lists.map(({ format, start, base }, index) => {
        const levels = Array.from(
            { length: LIST_LEVELS },
            (_, ilvl) =>
                `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${format === 'bullet' ? '•' : `%${ilvl + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr>${pPrXml({ ind: { left: base + LIST_LEVEL * (ilvl + 1), hanging: LIST_LEVEL } })}</w:pPr></w:lvl>`,
        );
        const nsid = (index + 1).toString(16).toUpperCase().padStart(8, '0');
        return `<w:abstractNum w:abstractNumId="${index}"><w:nsid w:val="${nsid}"/>${levels.join('')}</w:abstractNum>`;
    });
    const numXml = numToAbstract.map(
        (abstract, index) => `<w:num w:numId="${index + 1}"><w:abstractNumId w:val="${abstract}"/></w:num>`,
    );
    return `<w:numbering xmlns:w="${W_NS}">${abstractNums.join('')}${numXml.join('')}</w:numbering>`;
}

export const CHECKBOX_FONT = 'MS Gothic';

// Word's checkbox in MS Gothic, as Inter has no ballot box; the tab is unstruck, so Task Done's line starts at text.
export function checkboxXml(checked: boolean): string {
    const state = (name: string, glyph: string) =>
        `<w14:${name} w14:val="${glyph.codePointAt(0)?.toString(16).toUpperCase()}" w14:font="${CHECKBOX_FONT}"/>`;
    return [
        `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/>${state('checkedState', CHECKBOX_GLYPHS.checked)}${state('uncheckedState', CHECKBOX_GLYPHS.unchecked)}</w14:checkbox></w:sdtPr>`,
        `<w:sdtContent><w:r><w:rPr>${rPrXml({ font: CHECKBOX_FONT, strike: false })}</w:rPr><w:t>${checked ? CHECKBOX_GLYPHS.checked : CHECKBOX_GLYPHS.unchecked}</w:t></w:r></w:sdtContent></w:sdt>`,
        `<w:r><w:rPr>${rPrXml({ strike: false })}</w:rPr><w:tab/></w:r>`,
    ].join('');
}
