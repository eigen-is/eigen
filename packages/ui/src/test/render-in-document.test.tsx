// A test that ends before its render resolves, as one that times out inside render() does, never gets the unmount its
// own afterEach would call. The next test still starts with an empty document: no stale root, no dialog in the body.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from './happy-dom';
import { renderInDocument } from './render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../components/dialog');

// The pattern most component tests use. A test that times out leaves this as the no-op.
let unmount = async () => {};
afterEach(() => unmount());

const openDialog = () =>
    createElement(
        Dialog,
        { open: true },
        createElement(
            DialogContent,
            null,
            createElement(DialogTitle, null, 'Stale'),
            createElement(DialogDescription, null, 'From an earlier test'),
        ),
    );

// Long enough for any render a finished test left running to land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function expectEmptyDocument() {
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.children.length).toBe(0);
}

test('a test that ends while its render is still loading React', () => {
    void renderInDocument(openDialog());
});

test('leaves no root and no dialog for the next test', async () => {
    await settle();
    expectEmptyDocument();
});

test('a test that ends after the dialog rendered but before it got its unmount', async () => {
    const late = renderInDocument(openDialog());
    while (!document.querySelector('[role="dialog"]')) await new Promise((resolve) => setTimeout(resolve, 0));
    void late.then((rendered) => {
        ({ unmount } = rendered);
    });
});

test('leaves no root and no dialog either, and a fresh render owns the document', async () => {
    await settle();
    expectEmptyDocument();
    ({ unmount } = await renderInDocument(openDialog()));
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
});

test('the cleanup unmounts a root its test never unmounted', async () => {
    await renderInDocument(openDialog());
});

test('so the next test finds no dialog', () => {
    expectEmptyDocument();
});
