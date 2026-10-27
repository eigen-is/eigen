// Closing a text file returns to its folder, or to Shared with me when the file was shared on its own and
// the viewer can't read that folder (the file then heads its own breadcrumb chain).
import { beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const navigate = mock((_target: unknown) => {});
const params = { ownerId: 'owner-1', mountId: 'mount-1', pathId: 'file-1' };
const realRouter = await import('@tanstack/react-router');
mock.module('@tanstack/react-router', () => ({
    ...realRouter,
    createFileRoute: () => (options: object) => ({ options, useParams: () => params }),
    useNavigate: () => navigate,
}));

// One object per hook, so the component's effects see stable data across renders.
const pathInfo = { data: { id: 'file-1', parentId: 'folder-1' } };
const breadcrumb: { data: { id: string }[] } = { data: [] };
mock.module('@workspace/lib/drive', () => ({
    usePathInfo: () => pathInfo,
    useBreadcrumb: () => breadcrumb,
}));

const { act, createElement } = await import('react');
mock.module('../../components/editor/native-file-editor', () => ({
    NativeFileEditor: ({ onClose }: { onClose: () => void }) =>
        createElement('button', { type: 'button', onClick: onClose }, 'Close'),
}));

const { Route } = await import('../../routes/_auth.edit.$ownerId.$mountId.$pathId');

async function closeFile() {
    const Edit = Route.options.component;
    if (!Edit) throw new Error('the edit route has no component');
    const { container, unmount } = await renderInDocument(createElement(Edit));
    await act(async () => {
        container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await unmount();
}

beforeEach(() => {
    navigate.mockClear();
});

test('closing a file in a readable folder goes to that folder', async () => {
    breadcrumb.data = [{ id: 'folder-1' }, { id: 'file-1' }];
    await closeFile();
    expect(navigate).toHaveBeenCalledWith({
        to: '/fs/$ownerId/$mountId/$pathId',
        params: { ownerId: 'owner-1', mountId: 'mount-1', pathId: 'folder-1' },
    });
});

test('closing a file shared on its own goes to Shared with me', async () => {
    breadcrumb.data = [{ id: 'file-1' }];
    await closeFile();
    expect(navigate).toHaveBeenCalledWith({ to: '/shared/$to', params: { to: 'with-me' } });
});
