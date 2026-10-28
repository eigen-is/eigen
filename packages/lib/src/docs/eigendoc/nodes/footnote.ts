// Google's and Word's footnote: a reference in the body's text that holds its note's paragraphs. Notes number in
// document order and are never stored numbered. A note is one of the doc's stories, with a stable id. Its readers, such
// as the note's own editor and the exports, read it through this node.

import type { JSONContent } from '@tiptap/core';
import { Node } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { DOMSerializer, Fragment, DOMParser as PMDOMParser } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { flattenNestedStories, insertStory, newStoryId, readStoryId, STORY_ID_ATTRIBUTE } from './stories';

const NAME = 'footnote';

// A note's paragraph in HTML: a span, as a <p> inside the body's <p> closes it in every HTML parser.
export const FOOTNOTE_PARAGRAPH = 'footnote-paragraph';

// data-type, as a web page's own span.footnote is its text.
export const FOOTNOTE_SELECTOR = `span[data-type="${NAME}"]`;

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

// A reference after the selection, with its note one empty paragraph, where insertStory puts a story.
export function insertFootnote(tr: Transaction): number | null {
    return insertStory(tr, tr.doc.type.schema.nodes[NAME]?.createAndFill({ id: newStoryId() }));
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
    return note ? schema.nodeFromJSON(flattenNestedStories(note.toJSON())).content : Fragment.empty;
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

    // Null until an insert, an import or a paste sets one.
    addAttributes() {
        return {
            id: {
                default: null,
                parseHTML: (element: HTMLElement) => readStoryId(element.getAttribute(STORY_ID_ATTRIBUTE)),
            },
        };
    },

    parseHTML() {
        return [{ tag: FOOTNOTE_SELECTOR, getContent: noteContent }];
    },

    // Built, not a spec with a hole, which would render each paragraph as a <p>.
    renderHTML({ node }) {
        const serializer = DOMSerializer.fromSchema(node.type.schema);
        const dom = document.createElement('span');
        dom.className = NAME;
        dom.setAttribute('data-type', NAME);
        const id = readStoryId(node.attrs['id']);
        if (id) dom.setAttribute(STORY_ID_ATTRIBUTE, id);
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
