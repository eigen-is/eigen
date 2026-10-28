// Vector's list pages show vector files only: every vector the user can reach at the index, one team
// drive's at its drive page. An empty list points at the New vector button, and a list that fails to
// load says so.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_VECTOR, DRIVE_TYPE_VECTOR } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();
window.happyDOM.setViewport({ width: 1440, height: 900 });
// happy-dom lays nothing out, so the list's virtualizer would see a scroller 0 px tall and draw no row. The
// window is this file's own, so the stub goes with it.
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 900 });

const VECTOR_SLUG = 'application-eigenvector';
const vector = (id: string, name: string, ownerId = 'u1', mountId = 'default'): DrivePath =>
    drivePath({ id, name, ownerId, mountId, type: DRIVE_TYPE_VECTOR, mimeType: DRIVE_MIME_VECTOR });

// The listings, stubbed per query: what each list asked for, and the one answer the vector slug gets.
type Listing = { data: DrivePath[] | undefined; isLoading: boolean; error: Error | null };
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const vectors: Listing = { data: [], isLoading: false, error: null };
const teamVectors: Listing = { data: [], isLoading: false, error: null };
const none: Listing = { data: [], isLoading: false, error: null };
const noPath = { data: undefined };
const asked: string[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useAggregateMimeContent: (mimeType: string) => {
        if (mimeType) asked.push(`all ${mimeType}`);
        return mimeType === VECTOR_SLUG ? vectors : none;
    },
    useMountMimeContent: (ownerId: string, mountId: string, mimeType: string) => {
        if (ownerId) asked.push(`${ownerId}/${mountId} ${mimeType}`);
        return ownerId && mimeType === VECTOR_SLUG ? teamVectors : none;
    },
    useMimeContent: (ownerId: string, mimeType: string) => {
        if (ownerId) asked.push(`${ownerId} ${mimeType}`);
        return none;
    },
    usePathInfo: () => noPath,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
});

const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { CommandPaletteProvider } = await import('@workspace/ui/components/layout/app');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    vectors.data = [vector('v1', 'Logo.eigenvector'), vector('v2', 'Floor plan.eigenvector', 'team-1', 'm1')];
    vectors.error = null;
    teamVectors.data = [vector('v2', 'Floor plan.eigenvector', 'team-1', 'm1')];
    asked.length = 0;
});

async function open(url: string) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth },
    });
    await router.load();
    // A row's preview, an upload and the list's palette actions go through the providers every app mounts.
    const rendered = await renderInDocument(
        <UploadProvider>
            <PreviewProvider>
                <CommandPaletteProvider>
                    <RouterProvider router={router} />
                </CommandPaletteProvider>
            </PreviewProvider>
        </UploadProvider>,
    );
    unmount = rendered.unmount;
    return () => rendered.container.textContent ?? '';
}

test('the index lists every vector the user can reach, and asks for nothing else', async () => {
    const text = await open('/');
    expect(text()).toContain('Logo');
    expect(text()).toContain('Floor plan');
    expect(asked.filter((query) => query.startsWith('all '))).toContain(`all ${VECTOR_SLUG}`);
    expect(asked.every((query) => query.endsWith(VECTOR_SLUG))).toBe(true);
});

test("a team drive's page lists that drive's vectors alone", async () => {
    teamVectors.data = [vector('v3', 'Team badge.eigenvector', 'team-1', 'm1')];
    const text = await open('/drive/team-1/m1');
    expect(asked).toContain(`team-1/m1 ${VECTOR_SLUG}`);
    expect(text()).toContain('Team badge');
    expect(text()).not.toContain('Logo');
});

test('an empty list points at the New vector button', async () => {
    vectors.data = [];
    const text = await open('/');
    expect(text()).toContain('Use the “New vector” button to create one.');
});

test('a list that fails to load says so', async () => {
    vectors.data = undefined;
    vectors.error = new Error('Service unavailable');
    const text = await open('/');
    expect(text()).toContain('Encountering the null vector');
    expect(text()).not.toContain('Logo');
});
