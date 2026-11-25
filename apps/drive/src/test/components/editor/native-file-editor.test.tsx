// Edit on a text file swaps in its editor with the focus in the text, so typing goes there at once: the code editor
// for a .txt or source file, the rich editor for a .md.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

type Content = { content: string; etag: string; editMode: 'markdown' | 'code'; frontmatter?: string };
let content: Content = { content: 'first draft', etag: '"opened"', editMode: 'code' };
// One object per hook, as a mocked hook returns, so nothing that depends on it runs again on every render.
const fileContent = {
    get data() {
        return content;
    },
    isLoading: false,
    error: null,
};
const permissions = { data: { canWrite: true } };
const preview = { data: { body: '<p>first draft</p>' }, isError: false };
const breadcrumb = { data: [] };
const fileSave = { mutateAsync: async () => ({ conflict: false, etag: '"saved"' }) };
const auth = { user: { id: 'owner-1', email: 'owner@example.com' } };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realEditor = { ...(await import('@workspace/lib/editor')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realDriveUi = { ...(await import('@workspace/ui/components/drive')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => auth }));
mock.module('@workspace/lib/editor', () => ({
    ...realEditor,
    useFileContent: () => fileContent,
    useFileSave: () => fileSave,
}));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useCheckPermissions: () => permissions,
    useTextPreview: () => preview,
    useBreadcrumb: () => breadcrumb,
}));
mock.module('@workspace/ui/components/drive', () => ({ ...realDriveUi, useMountLabel: () => 'Drive' }));
afterAll(() => {
    mock.module('@workspace/lib/editor', () => realEditor);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/ui/components/drive', () => realDriveUi);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement } = await import('react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { NativeFileEditor } = await import('../../../components/editor/native-file-editor');

let unmount = async () => {};
afterEach(() => unmount());

async function editFile(name: string) {
    const path = drivePath({ name, mimeType: 'text/plain' });
    const rootRoute = createRootRoute({
        component: () => createElement(NativeFileEditor, { path, onClose: () => {} }),
    });
    const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
    await router.load();
    ({ unmount } = await renderInDocument(
        createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router })),
    ));
    const edit = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit');
    if (!edit) throw new Error('no Edit button');
    await act(async () => edit.click());
    // The editors load on first use.
    for (let tries = 0; tries < 50 && !document.querySelector('[contenteditable="true"]'); tries++) {
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    // The rich editor takes the focus a task after it mounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

test('Edit on a text file puts the focus in the code editor', async () => {
    content = { content: 'first draft', etag: '"opened"', editMode: 'code' };
    await editFile('notes.txt');
    const text = document.querySelector('.cm-content');
    expect(text).not.toBeNull();
    expect(document.activeElement === text).toBe(true);
});

test('Edit on a Markdown file puts the focus in the rich editor', async () => {
    content = { content: '# Notes', etag: '"opened"', editMode: 'markdown' };
    await editFile('notes.md');
    const text = document.querySelector('.ProseMirror');
    expect(text).not.toBeNull();
    expect(document.activeElement === text).toBe(true);
});
