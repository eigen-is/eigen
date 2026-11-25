// The Mail signature opens on the signature saved before, and a save sends it under the id it already had.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { EmailSignature } from '@workspace/lib/types/settings';
import type { LightEditor } from '@workspace/ui/components/editor';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { ComponentProps } from 'react';

installHappyDom();

// The TipTap editor LightEditor hands its host.
type Editor = Parameters<NonNullable<ComponentProps<typeof LightEditor>['onReady']>>[0]['editor'];

const SAVED: EmailSignature = { id: 'sig-1', name: 'Default', html: '<p>Ada</p>' };
const saveSignature = { mutate: mock((_signature: EmailSignature) => {}), isPending: false };
afterEach(() => saveSignature.mutate.mockClear());

// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realSpace = { ...(await import('@workspace/lib/space')) };
mock.module('@workspace/lib/space', () => ({
    ...realSpace,
    useSpaceSettings: () => ({ data: { email: { signatures: [SAVED] } }, isLoading: false }),
    useSaveSignature: () => saveSignature,
}));
afterAll(() => {
    mock.module('@workspace/lib/space', () => realSpace);
});

const { act, createElement } = await import('react');
const { SignatureSection } = await import('../../../components/space/signature-section');

test('the editor opens on the saved signature, and a save sends it under its id', async () => {
    await renderInDocument(createElement(SignatureSection));
    expect(editor().getHTML()).toBe('<p>Ada</p>');

    await act(async () => {
        editor().chain().focus('end').insertContent(' Lovelace').run();
    });
    await act(async () => saveButton().click());
    expect(saveSignature.mutate.mock.calls).toEqual([[{ id: 'sig-1', name: 'Default', html: '<p>Ada Lovelace</p>' }]]);
});

const saveButton = () => {
    const found = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save');
    if (!found) throw new Error('no Save button');
    return found;
};

// Tiptap hangs its editor on the editable element.
const editor = (): Editor => {
    const editable: (HTMLElement & { editor?: Editor }) | null = document.querySelector('.ProseMirror');
    if (!editable?.editor) throw new Error('no signature editor');
    return editable.editor;
};
