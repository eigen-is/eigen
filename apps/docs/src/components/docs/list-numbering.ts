import type { ResolvedPos } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';

// The depth of the innermost list around a position when that list is numbered, as Google's numbering acts on the
// list the caret is in: a bulleted list nested in a numbered one is no numbered list.
export function orderedListDepth($pos: ResolvedPos): number | undefined {
    for (let depth = $pos.depth; depth > 0; depth--) {
        const node = $pos.node(depth);
        if (node.type.isInGroup('list')) return node.type.name === 'orderedList' ? depth : undefined;
    }
    return undefined;
}

// Decimal is the schema's default, which a list stores as no type.
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
                type: type === '1' ? null : type,
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
