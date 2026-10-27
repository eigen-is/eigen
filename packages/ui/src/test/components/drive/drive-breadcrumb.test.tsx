// The crumbs a viewer reads above a folder or a file. The server trims another owner's chain to the part
// the viewer can read. A trimmed chain leads with Shared with me when the viewer's Shared with me feed
// holds a path in it, and starts at its first folder when only a public link opened it.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const root = drivePath({ id: 'root', name: 'Drive', type: 'folder', mimeType: DRIVE_MIME_FOLDER });
const projects = drivePath({
    id: 'projects',
    parentId: 'root',
    name: 'Projects',
    type: 'folder',
    mimeType: DRIVE_MIME_FOLDER,
});
const site = drivePath({ id: 'site', parentId: 'projects', name: 'Site', type: 'folder', mimeType: DRIVE_MIME_FOLDER });
const notes = drivePath({ id: 'notes', parentId: 'site', name: 'site access notes.txt', mimeType: 'text/plain' });

let sharedWithMe: ReturnType<typeof drivePath>[] = [];
g.fetch = async () => Response.json(sharedWithMe);

// Signed in only while this file runs: bun keeps a module mock for the files after it.
let mocked = true;
afterAll(() => {
    mocked = false;
});
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => (mocked ? { user: { id: 'viewer-1' }, isAuthenticated: true } : realAuth.useAuth()),
}));

const { act, createElement } = await import('react');
const { DriveBreadcrumb } = await import('../../../components/drive/drive-breadcrumb');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    sharedWithMe = [];
});

async function render(paths: ReturnType<typeof drivePath>[], onOpenSharedWithMe?: () => void): Promise<HTMLElement> {
    const rendered = await renderInDocument(
        createElement(DriveBreadcrumb, { paths, mountLabel: 'Drive', onNavigate: () => {}, onOpenSharedWithMe }),
    );
    unmount = rendered.unmount;
    // Lets the Shared with me feed answer and the row redraw.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    return rendered.container;
}

async function crumbs(paths: ReturnType<typeof drivePath>[]): Promise<string[]> {
    const container = await render(paths);
    return [...container.querySelectorAll('[data-slot="breadcrumb-item"]')].map((item) => item.textContent ?? '');
}

test('a chain from the mount root starts with the mount label', async () => {
    expect(await crumbs([root, projects, notes])).toEqual(['Drive', 'Projects', 'site access notes.txt']);
});

test('a file shared on its own reads Shared with me, then the file', async () => {
    sharedWithMe = [notes];
    expect(await crumbs([notes])).toEqual(['Shared with me', 'site access notes.txt']);
});

test('a folder inside a shared folder reads Shared with me, the shared folder, then the folder', async () => {
    sharedWithMe = [projects];
    expect(await crumbs([projects, site])).toEqual(['Shared with me', 'Projects', 'Site']);
});

test('a file in a shared folder keeps every folder between', async () => {
    sharedWithMe = [projects];
    expect(await crumbs([projects, site, notes])).toEqual([
        'Shared with me',
        'Projects',
        'Site',
        'site access notes.txt',
    ]);
});

test('a chain a public link opened, shared with nobody, starts at its first folder', async () => {
    expect(await crumbs([projects, site, notes])).toEqual(['Projects', 'Site', 'site access notes.txt']);
});

test('Shared with me is a link when the caller has the page, and plain text when it has not', async () => {
    sharedWithMe = [notes];
    const open = mock(() => {});
    const linked = await render([notes], open);
    const link = linked.querySelector('[data-slot="breadcrumb-link"]');
    expect(link?.textContent).toBe('Shared with me');
    await act(async () => link?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(open).toHaveBeenCalledTimes(1);
    await unmount();

    const plain = await render([notes]);
    expect(plain.querySelector('[data-slot="breadcrumb-link"]')).toBeNull();
    expect(plain.textContent).toContain('Shared with me');
});
