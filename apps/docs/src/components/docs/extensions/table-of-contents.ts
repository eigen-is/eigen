// The table of contents as the editor draws it: the body's headings to the node's level, indented and in their level's
// look. A press selects it, which opens its panel, and a mod-press on an entry jumps to its heading. A plugin reads the
// outline again on each change to a doc that holds one, wherever a paste put it, so the list follows a heading typed here
// or by a collaborator. Typing in a paragraph moves the headings but keeps their levels and texts, so it draws nothing.

import type { Editor } from '@tiptap/core';
import { isMacOS } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { OutlineEntry } from '@workspace/lib/docs/eigendoc';
import {
    readOutline,
    readTocLevelStyle,
    readTocLevels,
    TableOfContentsNode,
    TOC_LEVEL_KEYS,
    TOC_PRESET_ATTRIBUTE,
    tocLevelCss,
    tocPreset,
} from '@workspace/lib/docs/eigendoc';

export type TableOfContentsOptions = {
    // A mod-press on the entry for the heading at `pos`; the body's editor jumps there as the outline sidebar does.
    onJump: (pos: number) => void;
    // A right-click on the table of contents at `pos` in `editor`, such as the body's.
    onContextMenu: (editor: Editor, pos: number, event: MouseEvent) => void;
};

type Outline = { entries: readonly OutlineEntry[]; decorations: DecorationSet };

const outlineKey = new PluginKey<Outline>('tableOfContentsOutline');

const NO_ENTRIES: readonly OutlineEntry[] = [];

// The weight a bold mark draws at in the editor.
const BOLD_WEIGHT = 'var(--font-weight-bold)';

// The key a click holds to act on a node rather than on the text, as ProseMirror reads it. On a Mac, control and a click
// is the right-click.
const MOD_KEY = isMacOS() ? 'metaKey' : 'ctrlKey';

// The entries, and a decoration on each table of contents carrying them, which makes ProseMirror draw it again when they
// change. Only a doc that holds one reads its outline, and entries equal to the last ones keep their array, so no node
// draws again.
function outlineOf(doc: PMNode, last: readonly OutlineEntry[]): Outline {
    const tocs: { pos: number; size: number }[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name === TableOfContentsNode.name) tocs.push({ pos, size: node.nodeSize });
        return !node.isTextblock;
    });
    if (tocs.length === 0) return { entries: NO_ENTRIES, decorations: DecorationSet.empty };
    const read = readOutline(doc).map(({ level, text }) => ({ level, text }));
    const same =
        read.length === last.length &&
        read.every((entry, index) => entry.level === last[index]?.level && entry.text === last[index]?.text);
    const entries = same ? last : read;
    const decorations = tocs.map(({ pos, size }) => Decoration.node(pos, pos + size, {}, { entries }));
    return { entries, decorations: DecorationSet.create(doc, decorations) };
}

class TableOfContentsView implements NodeView {
    public dom: HTMLElement;
    private entries: readonly OutlineEntry[] | null = null;
    private node: PMNode | null = null;
    // The kind of pointer that pressed last. A finger holds no key to jump with.
    private pointerType = 'mouse';

    public constructor(
        node: PMNode,
        private readonly view: EditorView,
        private readonly getPos: () => number | undefined,
        private readonly jump: (index: number) => void,
        onContextMenu: (pos: number, event: MouseEvent) => void,
    ) {
        this.dom = document.createElement('nav');
        this.dom.setAttribute('data-type', 'table-of-contents');
        this.dom.setAttribute('aria-label', 'Table of contents');
        this.dom.contentEditable = 'false';
        this.dom.addEventListener('pointerdown', (event) => {
            this.pointerType = event.pointerType;
        });
        this.dom.addEventListener('contextmenu', (event) => {
            const pos = this.getPos();
            if (pos !== undefined) onContextMenu(pos, event);
        });
        this.draw(node);
    }

    public update(node: PMNode): boolean {
        if (node.type.name !== TableOfContentsNode.name) return false;
        this.draw(node);
        return true;
    }

    public ignoreMutation(): boolean {
        return true;
    }

    // An entry's index is its heading's in the whole outline, the deeper headings this one leaves out counted.
    private draw(node: PMNode): void {
        const entries = outlineKey.getState(this.view.state)?.entries ?? NO_ENTRIES;
        if (entries === this.entries && this.node?.sameMarkup(node)) return;
        this.entries = entries;
        this.node = node;
        const levels = readTocLevels(node.attrs['levels']);
        this.dom.setAttribute('data-levels', String(levels));
        // A page-less doc draws Links whatever is stored. A switch to it is no transaction, so the stylesheet draws
        // that from the page instead.
        this.dom.setAttribute(TOC_PRESET_ATTRIBUTE, tocPreset(node.attrs, false));
        const looks = TOC_LEVEL_KEYS.map((key) => tocLevelCss(readTocLevelStyle(node.attrs[key]), BOLD_WEIGHT));
        const lines: HTMLElement[] = entries.flatMap(({ level, text }, index) => {
            if (level > levels) return [];
            const line = document.createElement('a');
            line.setAttribute('data-level', String(level));
            // As wide as its text, so a press beside an entry selects the table of contents too.
            line.className = 'w-fit';
            line.textContent = text;
            const look = looks[level - 1];
            if (look) line.setAttribute('style', look);
            // A jump puts the caret in the heading. ProseMirror leaves a press whose default is prevented alone, so
            // it doesn't select the node on the release either.
            line.addEventListener('mousedown', (event) => {
                if (!this.jumps(event)) return;
                event.preventDefault();
                this.jump(index);
            });
            return [line];
        });
        if (lines.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'text-muted-foreground print:hidden';
            empty.textContent = 'Headings you add appear here';
            lines.push(empty);
        }
        this.dom.replaceChildren(...lines);
    }

    // A press selects the table of contents, which opens its panel, and a mod-press on an entry jumps. A viewer has no
    // panel, so any press jumps, as a link does in a read-only editor. A finger holds no key, so a tap on an entry of
    // the selected one jumps.
    private jumps(event: MouseEvent): boolean {
        if (!this.view.editable || event[MOD_KEY]) return true;
        const { selection } = this.view.state;
        return this.pointerType !== 'mouse' && selection instanceof NodeSelection && selection.from === this.getPos();
    }
}

export const TableOfContents = TableOfContentsNode.extend<TableOfContentsOptions>({
    addOptions() {
        return { onJump: () => {}, onContextMenu: () => {} };
    },

    addNodeView() {
        const { onJump, onContextMenu } = this.options;
        const { editor } = this;
        // The position is read on the press, as an edit above the heading may have moved it since the list was drawn.
        const jump = (index: number) => {
            const heading = readOutline(editor.state.doc)[index];
            if (heading) onJump(heading.pos);
        };
        return ({ node, view, getPos }) =>
            new TableOfContentsView(node, view, getPos, jump, (pos, event) => onContextMenu(editor, pos, event));
    },

    addProseMirrorPlugins() {
        return [
            new Plugin<Outline>({
                key: outlineKey,
                state: {
                    init: (_, state) => outlineOf(state.doc, NO_ENTRIES),
                    apply: (tr, value) => (tr.docChanged ? outlineOf(tr.doc, value.entries) : value),
                },
                props: { decorations: (state) => outlineKey.getState(state)?.decorations },
            }),
        ];
    },
});
