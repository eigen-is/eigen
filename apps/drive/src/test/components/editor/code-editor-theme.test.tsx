// Switching the app between light and dark while a text file is open keeps what was typed: the editor shows the
// edits, they are still unsaved, and Undo still takes them back.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { EditorSaveResult } from '@workspace/lib/types/file-kinds';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const fileSave = { mutateAsync: async (): Promise<EditorSaveResult> => ({ conflict: false, etag: '"saved"' }) };
// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realEditor = { ...(await import('@workspace/lib/editor')) };
mock.module('@workspace/lib/editor', () => ({ ...realEditor, useFileSave: () => fileSave }));
afterAll(() => {
    mock.module('@workspace/lib/editor', () => realEditor);
});

const { act, createElement } = await import('react');
const { EditorView } = await import('@codemirror/view');
const { createBrowserHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } = await import(
    '@tanstack/react-router'
);
const { CodeEditor } = await import('../../../components/editor/code-editor');

let unmount = async () => {};
afterEach(async () => {
    document.documentElement.classList.remove('dark');
    await unmount();
});

async function openEditor() {
    const rootRoute = createRootRoute({ component: Outlet });
    const edit = createRoute({
        getParentRoute: () => rootRoute,
        path: '/edit',
        component: () =>
            createElement(CodeEditor, {
                content: 'first draft',
                etag: '"opened"',
                ownerId: 'owner-1',
                mountId: 'mount-1',
                pathId: 'file-1',
                fileName: 'notes.txt',
                canWrite: true,
                onBack: () => {},
                onCancel: () => {},
                onSaved: () => {},
                onReload: () => {},
            }),
    });
    window.history.replaceState(null, '', '/edit');
    const router = createRouter({ routeTree: rootRoute.addChildren([edit]), history: createBrowserHistory() });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
}

function view() {
    const dom = document.querySelector<HTMLElement>('.cm-editor');
    const found = dom && EditorView.findFromDOM(dom);
    if (!found) throw new Error('the editor drew no CodeMirror view');
    return found;
}

async function type() {
    const editor = view();
    await act(async () => editor.dispatch({ changes: { from: 0, insert: 'more ' } }));
}

// The theme hook watches the root element's class, which a MutationObserver reports after a microtask.
async function switchTheme() {
    await act(async () => {
        document.documentElement.classList.toggle('dark');
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function unsaved() {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
}

const shown = () => document.querySelector('.cm-content')?.textContent;

test('a theme switch keeps the typed text, still unsaved', async () => {
    await openEditor();
    await type();
    await switchTheme();
    expect(shown()).toBe('more first draft');
    expect(unsaved()).toBe(true);
    await switchTheme();
    expect(shown()).toBe('more first draft');
});

test('typing after a theme switch adds to the kept edits, and Undo still takes them back', async () => {
    await openEditor();
    await type();
    await switchTheme();
    await type();
    expect(shown()).toBe('more more first draft');
    const undoButton = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Undo');
    if (!undoButton) throw new Error('no Undo button');
    await act(async () => undoButton.click());
    expect(shown()).toBe('first draft');
});
