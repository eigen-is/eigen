// A text file's edit toolbar keeps Save's label beside a spinner while the save runs, and ignores another click.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { EditToolbar } = await import('../../../components/editor/editor-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

test('a running save keeps the Save label, says it is busy and ignores another click', async () => {
    const onSave = mock(() => {});
    ({ unmount } = await renderInDocument(
        createElement(EditToolbar, { onBack: () => {}, onCancel: () => {}, onSave, isSaving: true }),
    ));
    // A pending button's spinner comes before its label.
    const save = [...document.querySelectorAll('button')].find((b) => b.lastChild?.textContent === 'Save');
    expect(save?.getAttribute('aria-busy')).toBe('true');
    await act(async () => save?.click());
    expect(onSave).not.toHaveBeenCalled();
});
