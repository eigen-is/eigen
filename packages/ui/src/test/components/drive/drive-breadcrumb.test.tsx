// The crumbs a viewer reads above a folder or a file. The server trims another owner's chain to the part
// the viewer can read, so a chain that starts below the mount root came from a share.
import { afterEach, expect, test } from 'bun:test';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { DriveBreadcrumb } = await import('../../../components/drive/drive-breadcrumb');

let unmount = async () => {};
afterEach(() => unmount());

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

async function crumbs(paths: ReturnType<typeof drivePath>[]): Promise<string[]> {
    const { container, unmount: u } = await renderInDocument(
        createElement(DriveBreadcrumb, { paths, mountLabel: 'Drive', onNavigate: () => {} }),
    );
    unmount = u;
    return [...container.querySelectorAll('[data-slot="breadcrumb-item"]')].map((item) => item.textContent ?? '');
}

test('a chain from the mount root starts with the mount label', async () => {
    expect(await crumbs([root, projects, notes])).toEqual(['Drive', 'Projects', 'site access notes.txt']);
});

test('a file shared on its own reads Shared with me, then the file', async () => {
    expect(await crumbs([notes])).toEqual(['Shared with me', 'site access notes.txt']);
});

test('a folder inside a shared folder reads Shared with me, the shared folder, then the folder', async () => {
    expect(await crumbs([projects, site])).toEqual(['Shared with me', 'Projects', 'Site']);
});

test('a file in a shared folder keeps every folder between', async () => {
    expect(await crumbs([projects, site, notes])).toEqual([
        'Shared with me',
        'Projects',
        'Site',
        'site access notes.txt',
    ]);
});
