// The Mail signature keeps the page rules: Cmd+Enter in the editor saves once, its Save spins while the save runs, and
// leaving with an unsaved change asks. It opens on the saved signature and takes no focus as the Mail page opens, its
// Save waits greyed until something changed, and a save sends the signature under the id it already had.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { EmailSignature } from '@workspace/lib/types/settings';
import type { LightEditor } from '@workspace/ui/components/editor';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { ComponentProps } from 'react';

installHappyDom();

// The TipTap editor LightEditor hands its host.
type Editor = Parameters<NonNullable<ComponentProps<typeof LightEditor>['onReady']>>[0]['editor'];

const SAVED: EmailSignature = { id: 'sig-1', name: 'Default', html: '<p>Ada</p>' };
const saveSignature = { mutateAsync: mock(async (_signature: EmailSignature) => ({})) };
afterEach(() => saveSignature.mutateAsync.mockClear());

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
const router = await import('@tanstack/react-router');
const { SignatureSection } = await import('../../../components/space/signature-section');

test('the signature keeps the page rules', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(SignatureSection),
        submitLabel: 'Save',
        firstField: 'Signature',
        onSubmit: saveSignature.mutateAsync,
        makeChanged: () => typeSignature(' Lovelace'),
        except: { focus: 'the signature shares the Mail page with other sections, so it takes no focus as it opens' },
    });
});

test('opens on the saved signature, Save waits greyed until something changed, and it saves under its id', async () => {
    await renderPage();
    expect(editor().getHTML()).toBe('<p>Ada</p>');
    expect(saveButton().disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);

    await typeSignature(' Lovelace');
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(saveSignature.mutateAsync.mock.calls).toEqual([
        [{ id: 'sig-1', name: 'Default', html: '<p>Ada Lovelace</p>' }],
    ]);
});

async function renderPage() {
    const root = router.createRootRoute({ component: () => createElement(SignatureSection) });
    const memory = router.createRouter({
        routeTree: root,
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
}

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

const typeSignature = (text: string) =>
    act(async () => {
        editor().chain().focus('end').insertContent(text).run();
    });
