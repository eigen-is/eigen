// The two rewrites of the sheet a reference names. A reference holds a sheet id, so a rename or a deleted sheet
// rewrites nothing; text changes only where a sheet gets a new id, as an imported or duplicated tab does, and where
// a sheet appears under a name some formula was already typed with.

import { sheetNameKey } from '../text/sheet-name';
import type { FormulaNode } from '../text/tree';
import { leaf, NodeKind, referenceNode, SheetKind } from '../text/tree';
import { mapLeaves } from './leaves';

// Every sheet id that is a key of `ids` becomes its value.
export function remapSheets(tree: FormulaNode, ids: ReadonlyMap<string, string>): FormulaNode {
    return mapLeaves(tree, (node) => {
        if (node.sheetKind !== SheetKind.Id) return node;
        const id = ids.get(node.sheet);
        return id === undefined ? node : onSheet(node, id);
    });
}

// Binds what was typed with the name of a sheet that did not exist to the sheet that now has that name.
export function bindSheet(tree: FormulaNode, name: string, id: string): FormulaNode {
    const key = sheetNameKey(name);
    return mapLeaves(tree, (node) =>
        node.sheetKind === SheetKind.Name && sheetNameKey(node.sheet) === key ? onSheet(node, id) : node,
    );
}

function onSheet(node: FormulaNode, id: string): FormulaNode {
    if (node.kind !== NodeKind.Ref) return leaf(node.kind, node.value, node.text, node.space, SheetKind.Id, id);
    const { row, column, row2, column2 } = node;
    return referenceNode(node.op, node.space, SheetKind.Id, id, row, column, row2, column2, node.flags);
}
