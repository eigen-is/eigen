import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { writeMathml } from '@workspace/math';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { commentAnchorText, nodeCommentCardId } from '../../../../components/docs/extensions/comment-mark';

// An equation reads its stored MathML with DOMParser.
installHappyDom();

const schema = getSchema(getDocExtensions());

test('a comment on an equation anchors by its attribute and quotes its LaTeX', () => {
    const mathml = writeMathml([{ kind: 'identifier', text: 'x' }], 'x^2');
    const doc = schema.nodeFromJSON({
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [{ type: 'equation', attrs: { mathml, commentCardId: 'card-1' } }],
            },
        ],
    });
    const equation = doc.firstChild?.firstChild;
    expect(equation && nodeCommentCardId(equation)).toBe('card-1');
    expect(commentAnchorText(doc, 0, doc.content.size)).toBe('x^2');
});
