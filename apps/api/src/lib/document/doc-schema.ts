import { type Extensions, getSchema, type JSONContent } from '@tiptap/core';
import { type Node, Schema } from '@tiptap/pm/model';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { lowlight } from './lowlight';

type DocSchemas = { extensions: Extensions; schema: Schema; reversedMarks: Schema };

// Built on first use: the code text preview loads the doc renderers only to highlight.
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
