// The server's one eigendoc schema: the editor's extensions with the backend's lowlight, built once, on first use.
// The doc import, the Yjs conversion and the export renderers read and write documents through it, so the server
// accepts what the editor accepts.

import type { Extensions, JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Schema } from '@tiptap/pm/model';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { lowlight } from './lowlight';

type DocSchemas = { extensions: Extensions; schema: Schema; reversedMarks: Schema };

let built: DocSchemas | undefined;

function schemas(): DocSchemas {
    if (built) return built;
    const extensions = getDocExtensions({ lowlight });
    const schema = getSchema(extensions);
    const marks = Object.fromEntries(Object.entries(schema.spec.marks.toObject()).reverse());
    built = { extensions, schema, reversedMarks: new Schema({ ...schema.spec, marks }) };
    return built;
}

// The server's one eigendoc schema, the editor's with the backend's lowlight.
export function docExtensions(): Extensions {
    return schemas().extensions;
}

export function docSchema(): Schema {
    return schemas().schema;
}

// The static renderer wraps a text's first mark innermost, where the editor draws it outermost. Over marks ranked in
// reverse it nests them as the editor does: a link's <a> outside its color.
export function inEditorMarkOrder(json: JSONContent): Node {
    return schemas().reversedMarks.nodeFromJSON(json);
}
