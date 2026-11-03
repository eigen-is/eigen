// A code block's floating actions, such as its copy button, show on the block's hover and when Tab reaches a control
// in it. A mouse click into the code leaves the focus there, so a focus-within reveal would keep them shown after the
// pointer left. At rest they are invisible and take no clicks, so a click there reaches the code under them.
import { expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } = await import(
    '../../components/code-block'
);

async function renderFloatingActions() {
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
    return [...actions.classList];
}

test('at rest the floating actions take no clicks, and each reveal gives them back', async () => {
    const classes = await renderFloatingActions();
    const revealsOf = (look: string) =>
        classes.filter((token) => token.endsWith(`:${look}`)).map((token) => token.slice(0, -look.length));
    expect(classes).toContain('[[data-slot=code-block]>&]:pointer-events-none');
    expect(revealsOf('pointer-events-auto')).toEqual(revealsOf('opacity-100'));
});

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
