// DialogDescription wraps a long unbroken word, such as a file name, instead of making the dialog scroll sideways.
import { expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../../components/dialog');

test('the description breaks long words', async () => {
    const { unmount } = await renderInDocument(
        createElement(
            Dialog,
            { open: true },
            createElement(
                DialogContent,
                null,
                createElement(DialogTitle, null, 'Import'),
                createElement(DialogDescription, null, `${'a'.repeat(200)}.ics`),
            ),
        ),
    );
    expect(document.querySelector('[data-slot="dialog-description"]')?.classList.contains('break-words')).toBe(true);
    await unmount();
});
