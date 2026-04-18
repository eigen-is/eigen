import type { Sheet } from '@workspace/lib/sheets';
import type * as Y from 'yjs';

export function writeSheetsToDoc(doc: Y.Doc, sheets: Sheet[]): void {
    const json = JSON.stringify(sheets);
    doc.transact(() => {
        doc.getMap('state').set('snapshot', json);
        const ops = doc.getArray('ops');
        if (ops.length > 0) ops.delete(0, ops.length);
    });
}
