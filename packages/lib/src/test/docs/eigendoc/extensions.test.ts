// Clear formatting takes every mark but the ones that aren't formatting: a comment's anchor and a link, as in Google Docs.
import { expect, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import { getDocExtensions } from '../../../docs/eigendoc';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const ATTRS: Record<string, Record<string, unknown>> = {
    comment: { cardId: 'card-1' },
    link: { href: 'https://eigen.is' },
    textStyle: { color: '#ff0000' },
};

test('Clear formatting keeps the comment and the link, and takes every other mark in the schema', () => {
    const editor = new Editor({ extensions: getDocExtensions() });
    const kept = Object.keys(editor.schema.marks).filter((name) => {
        editor.commands.setContent({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'word', marks: [{ type: name, attrs: ATTRS[name] }] }],
                },
            ],
        });
        const carries = () =>
            (editor.state.doc.firstChild?.firstChild?.marks ?? []).some((mark) =>
                mark.eq(editor.schema.mark(name, ATTRS[name])),
            );
        expect(carries()).toBe(true);
        editor.chain().selectAll().clearNodes().unsetAllMarks().run();
        return carries();
    });
    editor.destroy();
    expect(kept.sort()).toEqual(['comment', 'link']);
});
