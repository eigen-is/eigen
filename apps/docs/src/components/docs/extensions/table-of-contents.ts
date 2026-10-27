// The table of contents as the editor draws it: the body's headings to the node's level, indented, each a line that
// jumps to its heading on a click, for a viewer too. A plugin reads the outline again on each change to a doc that holds
// one, wherever a paste put it, and keeps the entries in its state, so the list follows a heading typed here or by a
// collaborator. Typing in a paragraph moves the headings but keeps their levels and texts, so it draws nothing again.

import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { OutlineEntry } from '@workspace/lib/docs/eigendoc';
import { readOutline, readTocLevels, TableOfContentsNode } from '@workspace/lib/docs/eigendoc';

export type TableOfContentsOptions = {
    // A click on the entry for the heading at `pos`; the body's editor jumps there as the outline sidebar does.
    onJump: (pos: number) => void;
};

type Outline = { entries: readonly OutlineEntry[]; decorations: DecorationSet };

const outlineKey = new PluginKey<Outline>('tableOfContentsOutline');

const NO_ENTRIES: readonly OutlineEntry[] = [];

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
    private levels = 0;

    public constructor(
        node: PMNode,
        private readonly view: EditorView,
        private readonly jump: (index: number) => void,
    ) {
        this.dom = document.createElement('nav');
        this.dom.setAttribute('data-type', 'table-of-contents');
        this.dom.setAttribute('aria-label', 'Table of contents');
        this.dom.contentEditable = 'false';
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
        const levels = readTocLevels(node.attrs['levels']);
        if (entries === this.entries && levels === this.levels) return;
        this.entries = entries;
        this.levels = levels;
        this.dom.setAttribute('data-levels', String(levels));
        const lines: HTMLElement[] = entries.flatMap(({ level, text }, index) => {
            if (level > levels) return [];
            const line = document.createElement('a');
            line.setAttribute('data-level', String(level));
            // As wide as its text, so a press beside an entry selects the table of contents instead of jumping.
            line.className = 'w-fit';
            line.textContent = text;
            // A press would select the node; the jump puts the caret in the heading instead. ProseMirror leaves a press
            // whose default is prevented alone, so it doesn't select the node on the release either.
            line.addEventListener('mousedown', (event) => {
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
}

export const TableOfContents = TableOfContentsNode.extend<TableOfContentsOptions>({
    addOptions() {
        return { onJump: () => {} };
    },

    addNodeView() {
        const { onJump } = this.options;
        const { editor } = this;
        // The position is read on the click, as an edit above the heading may have moved it since the list was drawn.
        const jump = (index: number) => {
            const heading = readOutline(editor.state.doc)[index];
            if (heading) onJump(heading.pos);
        };
        return ({ node, view }) => new TableOfContentsView(node, view, jump);
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
