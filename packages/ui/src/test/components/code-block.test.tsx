// A code block's floating actions, such as its copy button, show on the block's hover and when Tab reaches a control
// in it. A mouse click into the code leaves the focus there, so a focus-within reveal would keep them shown after the
// pointer left.
import { expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } = await import(
    '../../components/code-block'
);

test('the floating actions reveal on hover and keyboard focus, never on focus-within', async () => {
    await renderInDocument(
        createElement(
            CodeBlock,
            null,
            createElement(CodeBlockActions, null, createElement(CodeBlockCopyButton, { value: 'ls' })),
            createElement(CodeBlockContent, null, 'ls'),
        ),
    );
    const actions = document.querySelector('[data-slot="code-block-actions"]');
    if (!actions) throw new Error('the code block has no actions');
    const reveals = [...actions.classList].filter((token) => token.endsWith(':opacity-100'));
    expect(reveals).toEqual([
        '[[data-slot=code-block]>&]:group-has-focus-visible/code-block:opacity-100',
        '[[data-slot=code-block]>&]:group-hover/code-block:opacity-100',
        '[[data-slot=code-block]>&]:pointer-coarse:opacity-100',
    ]);
});
