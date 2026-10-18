import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { listTypeOfStyle } from '@workspace/lib/docs/eigendoc';

// The depth of the innermost list around a position when that list is numbered, as Google's numbering acts on the
// list the caret is in: a bulleted list nested in a numbered one is no numbered list.
export function orderedListDepth($pos: ResolvedPos): number | undefined {
    for (let depth = $pos.depth; depth > 0; depth--) {
        const node = $pos.node(depth);
        if (node.type.isInGroup('list')) return node.type.name === 'orderedList' ? depth : undefined;
    }
    return undefined;
}

// A list with no type draws its depth's, from eigen-prose.css; one not drawn yet reads as decimal.
export function numberedListType(list: PMNode, dom: Node | null | undefined): string {
    const type = list.attrs['type'];
    if (type) return type;
    return (dom instanceof Element && listTypeOfStyle(getComputedStyle(dom).listStyleType)) || '1';
}

export function setNumberedListType(editor: Editor, type: string): void {
    editor
        .chain()
        .focus()
        .command(
            ({ state, commands }) =>
                orderedListDepth(state.selection.$from) !== undefined || commands.toggleOrderedList(),
        )
        .command(({ tr }) => {
            const { $from } = tr.selection;
            const depth = orderedListDepth($from);
            if (depth === undefined) return false;
            tr.setNodeMarkup($from.before(depth), undefined, {
                ...$from.node(depth).attrs,
                type,
            });
            return true;
        })
        .run();
}

// A list's numbering lives on the list, so a restart past its first item splits it there, as Google's does.
export function restartNumbering(editor: Editor, start: number): void {
    editor
        .chain()
        .focus()
        .command(({ tr }) => {
            const { $from } = tr.selection;
            const depth = orderedListDepth($from);
            if (depth === undefined) return false;
            const list = $from.node(depth);
            const attrs = { ...list.attrs, start };
            if ($from.index(depth) === 0) tr.setNodeMarkup($from.before(depth), undefined, attrs);
            else tr.split($from.before(depth + 1), 1, [{ type: list.type, attrs }]);
            return true;
        })
        .run();
}
