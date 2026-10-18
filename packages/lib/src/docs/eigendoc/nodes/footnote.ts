import { type JSONContent, Node } from '@tiptap/core';
import {
    DOMSerializer,
    Fragment,
    DOMParser as PMDOMParser,
    type Node as PMNode,
    type ResolvedPos,
    type Schema,
} from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';

const NAME = 'footnote';

// A note's paragraph in HTML: a span, as a <p> inside the body's <p> closes it in every HTML parser.
export const FOOTNOTE_PARAGRAPH = 'footnote-paragraph';

// data-type, as a web page's own span.footnote is its text.
export const FOOTNOTE_SELECTOR = `span[data-type="${NAME}"]`;

// The schema can't refuse a note inside a note: the note holds the body's own paragraph, and a content expression
// names what a node admits, never what it leaves out. So the insert refuses one, a paste flattens one, and every
// renderer and writer reads a forged one through this: its paragraphs' inline content in its place, each after a space.
export function flattenNestedFootnotes(node: JSONContent): JSONContent {
    if (node.type === NAME) return { ...node, content: node.content?.map(withoutFootnotes) };
    return node.content ? { ...node, content: node.content.map(flattenNestedFootnotes) } : node;
}

function withoutFootnotes(node: JSONContent): JSONContent {
    if (!node.content) return node;
    return {
        ...node,
        content: node.content.flatMap((child) =>
            child.type === NAME
                ? (child.content ?? []).flatMap((paragraph) => [
                      { type: 'text', text: ' ' },
                      ...(withoutFootnotes(paragraph).content ?? []),
                  ])
                : [withoutFootnotes(child)],
        ),
    };
}

// Notes number 1, 2, 3 in document order, never stored. A nested note takes none: it reads as text.
export function footnoteNumbers(doc: PMNode): Map<number, number> {
    const numbers = new Map<number, number>();
    doc.descendants((node, pos) => {
        if (node.type.name !== NAME) return true;
        numbers.set(pos, numbers.size + 1);
        return false;
    });
    return numbers;
}

// footnoteNumbers' order over stored JSON, for the server: note n is at index n - 1.
export function footnotesInOrder(node: JSONContent): JSONContent[] {
    if (node.type === NAME) return [node];
    return (node.content ?? []).flatMap(footnotesInOrder);
}

const inFootnote = ($pos: ResolvedPos): boolean => {
    for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type.name === NAME) return true;
    return false;
};

// A reference after the selection, which stays, as Word's and Google's insert keep a selected text, and the caret
// after it. Its note is one empty paragraph. Returns where the reference is, or null where no note goes: inside a note,
// where the textblock takes no inline node (a code block), and in a schema without one (a band's).
export function insertFootnote(tr: Transaction): number | null {
    const { $to } = tr.selection;
    const note = tr.doc.type.schema.nodes[NAME]?.createAndFill();
    if (!note || inFootnote($to) || !$to.parent.canReplaceWith($to.index(), $to.index(), note.type)) return null;
    tr.insert($to.pos, note);
    tr.setSelection(TextSelection.create(tr.doc, $to.pos + note.nodeSize));
    return $to.pos;
}

// One paragraph per paragraph span: Eigen writes nothing else in a note.
function noteContent(dom: globalThis.Node, schema: Schema): Fragment {
    const parser = PMDOMParser.fromSchema(schema);
    const paragraph = schema.nodes['paragraph'];
    const type = schema.nodes[NAME];
    if (!paragraph || !type) return Fragment.empty;
    const paragraphs = [...dom.childNodes]
        .filter((child) => child.nodeName === 'SPAN')
        .map((span) => parser.parse(span, { topNode: paragraph.create() }));
    const note = type.createAndFill(null, paragraphs);
    return note ? schema.nodeFromJSON(flattenNestedFootnotes(note.toJSON())).content : Fragment.empty;
}

// Google's and Word's footnote: the reference in the text, holding its note, so a copy, a paste, a delete, an undo and a
// collaborator's edit carry the note with it. Block content in an inline node, where ProseMirror's footnote example
// holds text*: a note has paragraphs.
export const FootnoteNode = Node.create({
    name: NAME,

    group: 'inline',

    inline: true,

    atom: true,

    content: 'paragraph+',

    isolating: true,

    // Selecting the reference selects the whole note.
    selectable: true,

    parseHTML() {
        return [{ tag: FOOTNOTE_SELECTOR, getContent: noteContent }];
    },

    // Built, not a spec with a hole, which would render each paragraph as a <p>.
    renderHTML({ node }) {
        const serializer = DOMSerializer.fromSchema(node.type.schema);
        const dom = document.createElement('span');
        dom.className = NAME;
        dom.setAttribute('data-type', NAME);
        node.forEach((paragraph) => {
            const span = document.createElement('span');
            span.setAttribute('data-type', FOOTNOTE_PARAGRAPH);
            span.append(serializer.serializeFragment(paragraph.content));
            dom.append(span);
        });
        return { dom };
    },

    // A plain-text copy reads the sentence without its notes: the number is the doc's order, which a text serializer
    // never sees, and the note's text would run into the sentence. The node is no leaf, so it has no leafText to give
    // an input rule: their match is checked against textBetween, which reads the note's text at its own positions.
    renderText() {
        return '';
    },
});
