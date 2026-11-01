// The table of contents: an atomic block that stores how deep it lists, as Word's TOC field does with \o "1-3", and how
// it looks: whether its entries show page numbers, their leader, and a font, size, bold and italic per level. Its
// entries are the doc's outline and are never stored. Every surface that draws one, such as the editor or an export,
// reads them from the headings as they are, and reads the stored look through the readers here. Insert puts one
// between the body's blocks only, and a properties panel sets the selected one's attributes.

import type { CommandProps } from '@tiptap/core';
import { canInsertNode, getChangedRanges, mergeAttributes, Node } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { EIGEN_FONT_NAMES, getFontFamily, readFontSize } from '../../../constants/fonts';
import { isRecord } from '../../../core/guards';
import { MAX_HEADING_LEVEL } from '../heading';

// The look of one level's entries. A fact left out draws as the body text: a bundled font's name, a size in pt, and
// bold and italic.
export type TocLevelStyle = { font?: string; size?: number; bold?: boolean; italic?: boolean };

// Google's three layouts, each a pair of Word's two facts.
export type TocPreset = 'dotted' | 'plain' | 'links';

// The character that leads from an entry to its page number.
type TocLeader = 'dot' | 'none';

// Word's two facts that make the layout: whether entries show their page number, and the leader to it.
type TocLayout = { pageNumbers: boolean; leader: TocLeader };

// The attribute holding one heading level's look, level1 to the deepest heading's. The test pins the count to the
// heading levels.
export const TOC_LEVEL_KEYS = ['level1', 'level2', 'level3', 'level4', 'level5', 'level6'] as const;

type TocLevelKey = (typeof TOC_LEVEL_KEYS)[number];

// Every stored attribute. A level's look is an attribute of its own, so two peers who edit two levels both keep theirs.
export type TocAttrs = TocLayout & { levels: number } & Record<TocLevelKey, TocLevelStyle | null>;

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        tableOfContents: {
            insertTableOfContents: () => ReturnType;
            updateTableOfContents: (attributes: Partial<TocAttrs>) => ReturnType;
        };
    }
}

const NAME = 'tableOfContents';

// Word's and Google's default depth: headings 1 to 3.
const DEFAULT_TOC_LEVELS = 3;

// The deepest heading level a table of contents lists. Any peer writes the attribute, so a number is held to the
// heading levels, and anything else lists the default.
export function readTocLevels(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(MAX_HEADING_LEVEL, Math.max(1, Math.round(value)))
        : DEFAULT_TOC_LEVELS;
}

// One level's look as a peer, a paste or the import wrote it: the font and size are held to what a font and a size mark
// allow, and the flags must be booleans. Anything else is dropped, and a look with nothing left is no look.
export function readTocLevelStyle(value: unknown): TocLevelStyle | null {
    if (!isRecord(value)) return null;
    const { font, bold, italic } = value;
    const size = readFontSize(value['size']);
    const style: TocLevelStyle = {
        ...(typeof font === 'string' && EIGEN_FONT_NAMES.includes(font) && { font }),
        ...(size !== undefined && { size }),
        ...(typeof bold === 'boolean' && { bold }),
        ...(typeof italic === 'boolean' && { italic }),
    };
    return Object.keys(style).length > 0 ? style : null;
}

// What each preset stores. Links stores no leader, as it shows no numbers, so the stored one comes back after it.
export const TOC_PRESETS: Readonly<Record<TocPreset, Readonly<Partial<TocLayout>>>> = {
    dotted: { pageNumbers: true, leader: 'dot' },
    plain: { pageNumbers: true, leader: 'none' },
    links: { pageNumbers: false },
};

// The attribute that names the layout a surface draws a table of contents in, when that is not Dotted.
export const TOC_PRESET_ATTRIBUTE = 'data-preset';

// Word's two facts as a peer, a paste or the import stored them, whatever the doc's paper.
export function readTocLayout(attrs: Record<string, unknown>): TocLayout {
    return { pageNumbers: readPageNumbers(attrs['pageNumbers']), leader: readTocLeader(attrs['leader']) };
}

// The layout every surface draws. A page-less doc has no page numbers to show, so it draws Links whatever is stored,
// and the stored facts come back when its pages do.
export function tocPreset(attrs: Record<string, unknown>, pageless: boolean): TocPreset {
    const { pageNumbers, leader } = readTocLayout(attrs);
    if (pageless || !pageNumbers) return 'links';
    return leader === 'none' ? 'plain' : 'dotted';
}

// A level's look as CSS declarations, as the marks draw them: the font's bundled stack, the size in pt, and italic.
// Bold draws at the weight a bold mark draws at on the surface, which each surface passes. Empty for no look.
export function tocLevelCss(look: TocLevelStyle | null, boldWeight: string): string {
    return [
        look?.font !== undefined && `font-family: ${getFontFamily(look.font)}`,
        look?.size !== undefined && `font-size: ${look.size}pt`,
        look?.bold === true && `font-weight: ${boldWeight}`,
        look?.italic === true && 'font-style: italic',
    ]
        .filter((declaration) => typeof declaration === 'string')
        .join('; ');
}

function readPageNumbers(value: unknown): boolean {
    return value !== false;
}

const TOC_LEADERS: readonly TocLeader[] = ['dot', 'none'];

function readTocLeader(value: unknown): TocLeader {
    return TOC_LEADERS.find((leader) => leader === value) ?? 'dot';
}

// A pasted level's JSON is read only up to this length, far past any look the reader keeps.
const MAX_PASTED_STYLE_LENGTH = 256;

// The reader of each attribute, by name, so the command writes only what a parse or a render would keep.
const ATTRIBUTE_READERS = new Map<string, (value: unknown) => unknown>([
    ['levels', readTocLevels],
    ['pageNumbers', readPageNumbers],
    ['leader', readTocLeader],
    ...TOC_LEVEL_KEYS.map((key): [string, (value: unknown) => unknown] => [key, readTocLevelStyle]),
]);

// Whether one goes in at the selection. The selection must sit in a textblock between the body's blocks, because one in
// a cell or a list item would need another tab stop for the docx's page numbers. The schema must hold the node too, and
// a band's doesn't. The check makes no dry run, so the toolbar can read it on every change.
export function canInsertTableOfContents(state: EditorState): boolean {
    const { selection } = state;
    const type = state.schema.nodes[NAME];
    const top = selection.$from.depth === 1 && selection.$to.depth === 1;
    return !!type && selection instanceof TextSelection && top && canInsertNode(state, type);
}

export const TableOfContentsNode = Node.create({
    name: NAME,

    group: 'block',

    atom: true,

    // Each attribute renders only apart from its default, so an untouched one's HTML stays as it was.
    addAttributes() {
        return {
            levels: {
                default: DEFAULT_TOC_LEVELS,
                parseHTML: (element: HTMLElement) =>
                    readTocLevels(Number.parseInt(element.getAttribute('data-levels') ?? '', 10)),
                renderHTML: (attributes: Record<string, unknown>) => ({
                    'data-levels': readTocLevels(attributes['levels']),
                }),
            },
            pageNumbers: {
                default: true,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-page-numbers') !== 'false',
                renderHTML: (attributes: Record<string, unknown>) =>
                    readPageNumbers(attributes['pageNumbers']) ? {} : { 'data-page-numbers': 'false' },
            },
            leader: {
                default: 'dot',
                parseHTML: (element: HTMLElement) => readTocLeader(element.getAttribute('data-leader')),
                renderHTML: (attributes: Record<string, unknown>) => {
                    const leader = readTocLeader(attributes['leader']);
                    return leader === 'dot' ? {} : { 'data-leader': leader };
                },
            },
            ...Object.fromEntries(
                TOC_LEVEL_KEYS.map((key) => [
                    key,
                    {
                        default: null,
                        parseHTML: (element: HTMLElement) => {
                            const text = element.getAttribute(`data-${key}`);
                            if (text === null || text.length > MAX_PASTED_STYLE_LENGTH) return null;
                            try {
                                return readTocLevelStyle(JSON.parse(text));
                            } catch {
                                return null;
                            }
                        },
                        renderHTML: (attributes: Record<string, unknown>) => {
                            const style = readTocLevelStyle(attributes[key]);
                            return style ? { [`data-${key}`]: JSON.stringify(style) } : {};
                        },
                    },
                ]),
            ),
        };
    },

    // Whatever the nav holds: the export writes the entries inside it, and they are derived again.
    parseHTML() {
        return [{ tag: 'nav[data-type="table-of-contents"]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['nav', mergeAttributes({ 'data-type': 'table-of-contents' }, HTMLAttributes)];
    },

    addCommands() {
        return {
            // Only where canInsertTableOfContents allows, and the new one selected, so its panel opens. The insert may
            // split the caret's paragraph or replace it, so the new one is found in the range the insert wrote.
            insertTableOfContents:
                () =>
                ({ chain, state }: CommandProps) => {
                    if (!canInsertTableOfContents(state)) return false;
                    return chain()
                        .insertContent({ type: this.name })
                        .command(({ tr }) => {
                            let inserted = -1;
                            for (const { newRange } of getChangedRanges(tr)) {
                                tr.doc.nodesBetween(newRange.from, newRange.to, (node, pos) => {
                                    if (node.type.name === this.name) inserted = pos;
                                    return inserted < 0;
                                });
                            }
                            if (inserted < 0) return false;
                            tr.setSelection(NodeSelection.create(tr.doc, inserted));
                            return true;
                        })
                        .scrollIntoView()
                        .run();
                },
            // The selected one's attributes the call gives, each through its reader, as updateEquation writes. Null
            // clears a level's look. An attribute step moves no position, so the node stays selected and its panel open.
            updateTableOfContents:
                (attributes) =>
                ({ tr, dispatch }: CommandProps) => {
                    const { selection } = tr;
                    if (!(selection instanceof NodeSelection) || selection.node.type.name !== this.name) return false;
                    if (!dispatch) return true;
                    for (const [name, value] of Object.entries(attributes)) {
                        const read = ATTRIBUTE_READERS.get(name);
                        if (read && value !== undefined) tr.setNodeAttribute(selection.from, name, read(value));
                    }
                    return true;
                },
        };
    },
});
