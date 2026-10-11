import { mergeAttributes, Node } from '@tiptap/core';

// Google Docs' and Word's Title and Subtitle paragraph styles. A p, as both write them in HTML, marked by data-type,
// so a web page's p.title pastes as a paragraph; eigen-prose.css draws the look.
function titleNode(name: 'title' | 'subtitle') {
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

// The size and color eigen-prose.css gives each, which a copy writes inline, as Google Docs and Word read a run by
// its look.
export const TITLE_LOOK_CSS: Record<'title' | 'subtitle', { fontSize: string; color?: string }> = {
    title: { fontSize: '26pt' },
    subtitle: { fontSize: '15pt', color: '#666666' },
};

export const TitleNode = titleNode('title');

export const SubtitleNode = titleNode('subtitle');
