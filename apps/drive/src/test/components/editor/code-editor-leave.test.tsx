// A text file with unsaved edits asks before Drive leaves it, whichever way: its own Back button, a sidebar link
// such as Recent files, or a reload or closed tab. It asks what every form asks: Discard goes, Keep editing keeps the
// edits. A clean or saved file leaves at once.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { EditorSaveResult } from '@workspace/lib/types/file-kinds';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

// One object, so the editor's save callback keeps its identity across renders. A test that holds `held` keeps
// every save in flight until it calls release.
let held: Promise<void> | undefined;
const fileSave = {
    mutateAsync: async (): Promise<EditorSaveResult> => {
        await held;
        return { conflict: false, etag: '"saved"' };
    },
};
function holdSaves() {
    let release = () => {};
    held = new Promise((resolve) => {
        release = resolve;
    });
    return async () => {
        await act(async () => release());
    };
}
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
    held = undefined;
    await unmount();
});

async function openEditor() {
    const rootRoute = createRootRoute({ component: Outlet });
    const recent = createRoute({ getParentRoute: () => rootRoute, path: '/recent', component: () => 'Recent files' });
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
                onBack: () => router.navigate({ to: '/recent' }),
                onCancel: () => {},
                onSaved: () => {},
                onReload: () => {},
            }),
    });
    window.history.replaceState(null, '', '/edit');
    const router = createRouter({ routeTree: rootRoute.addChildren([edit, recent]), history: createBrowserHistory() });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));

    const type = async () => {
        const dom = document.querySelector<HTMLElement>('.cm-editor');
        const view = dom && EditorView.findFromDOM(dom);
        if (!view) throw new Error('the editor drew no CodeMirror view');
        await act(async () => view.dispatch({ changes: { from: 0, insert: 'more ' } }));
    };
    const button = (name: string) => {
        const found = [...document.querySelectorAll('button')].find(
            (b) => b.textContent === name || b.getAttribute('aria-label') === name,
        );
        if (!found) throw new Error(`no ${name} button`);
        return found;
    };
    const click = async (name: string) => {
        await act(async () => button(name).click());
    };
    const leaveForRecent = async () => {
        await act(async () => {
            router.navigate({ to: '/recent' });
        });
    };
    const unload = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    };
    const at = () => router.state.location.pathname;
    return { type, click, leaveForRecent, unload, at };
}

const asking = () => document.body.textContent?.includes('Discard changes?') ?? false;

test('a clean file leaves for a sidebar link at once', async () => {
    const editor = await openEditor();
    expect(editor.unload()).toBe(false);
    await editor.leaveForRecent();
    expect(editor.at()).toBe('/recent');
});

test('unsaved edits ask before a sidebar link leaves, and Keep editing keeps them', async () => {
    const editor = await openEditor();
    await editor.type();
    await editor.leaveForRecent();
    expect(editor.at()).toBe('/edit');
    expect(asking()).toBe(true);
    expect(document.body.textContent).toContain('What you changed is not saved.');

    await editor.click('Keep editing');
    expect(editor.at()).toBe('/edit');
    expect(document.querySelector('.cm-content')?.textContent).toBe('more first draft');

    await editor.leaveForRecent();
    await editor.click('Discard');
    expect(editor.at()).toBe('/recent');
});

test('Back with unsaved edits asks once, then leaves', async () => {
    const editor = await openEditor();
    await editor.type();
    await editor.click('Files');
    expect(editor.at()).toBe('/edit');
    await editor.click('Discard');
    expect(editor.at()).toBe('/recent');
    expect(asking()).toBe(false);
});

test('the tab asks before it unloads while the file is unsaved, and not after a save', async () => {
    const editor = await openEditor();
    await editor.type();
    expect(editor.unload()).toBe(true);
    await editor.click('Save');
    expect(editor.unload()).toBe(false);
});

test('typing during a save keeps the file unsaved, so leaving still asks', async () => {
    const editor = await openEditor();
    const release = holdSaves();
    await editor.type();
    await editor.click('Save');
    await editor.type();
    await release();
    expect(editor.unload()).toBe(true);
    await editor.leaveForRecent();
    expect(editor.at()).toBe('/edit');
    expect(asking()).toBe(true);
});

test('leaving while a save is in flight asks, since that save may still fail', async () => {
    const editor = await openEditor();
    const release = holdSaves();
    await editor.type();
    await editor.click('Save');
    await editor.leaveForRecent();
    expect(editor.at()).not.toBe('/recent');
    expect(asking()).toBe(true);
    await release();
});
