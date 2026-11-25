// The Mail signature keeps the page rules: Cmd+Enter in the editor saves once, its Save spins while the save runs, and
// leaving with an unsaved change asks. It opens on the saved signature and takes no focus as the Mail page opens, a Save
// with nothing changed sends nothing, and a save sends the signature under the id it already had. A first signature
// keeps what was typed while it saved. A failed load shows an error instead of an empty editor, whose Save would wipe
// the saved signature.
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

// The settings query as the section reads it, swapped by a test to play a failed load and its refetch.
type Settings = { data?: { email: { signatures: EmailSignature[] } }; isLoading: boolean; isError: boolean };
const LOADED: Settings = { data: { email: { signatures: [SAVED] } }, isLoading: false, isError: false };
let settings = LOADED;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
afterEach(() => {
    saveSignature.mutateAsync.mockClear();
    settings = LOADED;
});

// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realSpace = { ...(await import('@workspace/lib/space')) };
mock.module('@workspace/lib/space', () => ({
    ...realSpace,
    useSpaceSettings: () => useSyncExternalStore(subscribe, () => settings),
    useSaveSignature: () => saveSignature,
}));
afterAll(() => {
    mock.module('@workspace/lib/space', () => realSpace);
});

const { act, createElement, useSyncExternalStore } = await import('react');
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

test('opens on the saved signature, a clean Save sends nothing, and it saves under its id', async () => {
    await renderPage();
    expect(editor().getHTML()).toBe('<p>Ada</p>');
    expect(document.activeElement).toBe(document.body);
    await act(async () => saveButton().click());
    expect(saveSignature.mutateAsync).not.toHaveBeenCalled();

    await typeSignature(' Lovelace');
    await act(async () => saveButton().click());
    expect(saveSignature.mutateAsync.mock.calls).toEqual([
        [{ id: 'sig-1', name: 'Default', html: '<p>Ada Lovelace</p>' }],
    ]);
});

test('a failed load shows an error, and the refetch opens the saved signature unchanged', async () => {
    settings = { isLoading: false, isError: true };
    await renderPage();
    expect(document.querySelector('.ProseMirror')).toBeNull();
    expect(document.body.textContent).toContain('Failed to load your signature.');

    await act(async () => {
        settings = LOADED;
        for (const listener of listeners) listener();
    });
    expect(editor().getHTML()).toBe('<p>Ada</p>');
});

test('a first signature keeps what was typed while it saved', async () => {
    settings = { data: { email: { signatures: [] } }, isLoading: false, isError: false };
    const { promise: saved, resolve } = Promise.withResolvers<object>();
    saveSignature.mutateAsync.mockImplementationOnce(() => saved);
    await renderPage();
    await typeSignature('Ada');
    await act(async () => saveButton().click());
    await typeSignature(' Lovelace');

    const [[first]] = saveSignature.mutateAsync.mock.calls;
    await act(async () => {
        resolve({});
        settings = { data: { email: { signatures: [first] } }, isLoading: false, isError: false };
        for (const listener of listeners) listener();
    });
    expect(editor().getHTML()).toBe('<p>Ada Lovelace</p>');
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
