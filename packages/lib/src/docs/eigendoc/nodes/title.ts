import { mergeAttributes, Node } from '@tiptap/core';

export type TitleType = 'title' | 'subtitle';

// Google Docs' and Word's Title and Subtitle paragraph styles. A p, as both write them in HTML, marked by data-type,
// so a web page's p.title pastes as a paragraph; eigen-prose.css draws the look.
function titleNode(name: TitleType) {
    return Node.create({
        name,
        group: 'block',
        content: 'inline*',
        defining: true,

        parseHTML() {
            // Above the paragraph's p.
            return [{ tag: `p[data-type="${name}"]`, priority: 51 }];
        },

        renderHTML({ HTMLAttributes }) {
            return ['p', mergeAttributes({ 'data-type': name }, HTMLAttributes), 0];
        },
    });
}

export const TitleNode = titleNode('title');

export const SubtitleNode = titleNode('subtitle');
