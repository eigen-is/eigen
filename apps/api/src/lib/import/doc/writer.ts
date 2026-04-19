import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

export function writeDocToYjs(doc: Y.Doc, pmJson: JSONContent, schema: Schema): void {
    doc.transact(() => {
        const fragment = doc.getXmlFragment('default');
        if (fragment.length > 0) fragment.delete(0, fragment.length);
    });

    const tempDoc = prosemirrorJSONToYDoc(schema, pmJson, 'default');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(tempDoc));
    tempDoc.destroy();
}
