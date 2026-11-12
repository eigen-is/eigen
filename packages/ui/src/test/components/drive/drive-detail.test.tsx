// The Location row of the Drive details panel: the drive and the folders down to the item's parent, read from the
// parent's breadcrumb, as a link to that folder. A sharee who can't read the folders above sees the owner as the
// drive, as plain text.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { getDriveItemUrl } from '@workspace/lib/api';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const folder = (id: string, name: string, parentId: string | null, ownerId = 'owner-1', mountId = 'default') =>
    drivePath({ id, name, parentId, ownerId, mountId, type: 'folder', mimeType: DRIVE_MIME_FOLDER });

const root = folder('root', 'Drive', null);
const projects = folder('projects', 'Projects', 'root');
const year = folder('year', '2026', 'projects');
const teamRoot = folder('team-root', 'Shared files', null, teamOwnerId('t1'), 'm1');

// The breadcrumb each parent reads, as the server trims it for this viewer, and the ids the panel asked for.
const chains = new Map<string, DrivePath[]>([
    ['year', [root, projects, year]],
    ['team-root', [teamRoot]],
    ['hidden', []],
]);
const breadcrumbReads: (string | undefined)[] = [];

const realDrive = { ...(await import('@workspace/lib/drive')) };
const realHome = { ...(await import('@workspace/lib/home')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
const panelParts = [
    '../../../components/drive/drive-preview',
    '../../../components/drive/drive-access-list',
    '../../../components/drive/recent-activity',
    '../../../components/layout/toolbar/watch-toggle-button',
    '../../../components/drive/use-drive-file-action-runner',
];
const realParts = await Promise.all(panelParts.map(async (part) => ({ ...(await import(part)) })));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useBreadcrumb: (_ownerId: string, _mountId: string, pathId: string | undefined) => {
        breadcrumbReads.push(pathId);
        return { data: pathId ? chains.get(pathId) : undefined, isError: false };
    },
}));
mock.module('@workspace/lib/home', () => ({
    ...realHome,
    useMyTeams: () => ({ data: [{ id: 't1', name: 'Design', mounts: [{ id: 'm1', name: 'Design files' }] }] }),
}));
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    useResolvedUser: () => ({ displayName: 'Alice Example' }),
}));
// The rest of the panel reads the server; only the details are under test.
mock.module(panelParts[0], () => ({ ...realParts[0], DrivePreview: () => null }));
mock.module(panelParts[1], () => ({ ...realParts[1], DriveAccessList: () => null }));
mock.module(panelParts[2], () => ({ ...realParts[2], RecentActivity: () => null }));
mock.module(panelParts[3], () => ({ ...realParts[3], WatchToggleButton: () => null }));
mock.module(panelParts[4], () => ({
    ...realParts[4],
    useDriveFileActionRunner: () => ({ actions: [], run: () => {}, dialogs: null }),
}));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/home', () => realHome);
    mock.module('@workspace/lib/public', () => realPublic);
    panelParts.forEach((part, index) => {
        mock.module(part, () => realParts[index]);
    });
});

const { createElement } = await import('react');
const { DRIVE_CAPABILITIES } = await import('../../../components/drive/drive-capabilities');
const { DriveDetail } = await import('../../../components/drive/drive-detail');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    breadcrumbReads.length = 0;
});

const actions = {
    capabilities: DRIVE_CAPABILITIES.readOnly,
    actionsFor: () => [],
    run: () => {},
    onCreateEigenDoc: {},
    dialogs: null,
};

async function location(path: DrivePath): Promise<Element> {
    ({ unmount } = await renderInDocument(createElement(DriveDetail, { path, siblings: [path], actions })));
    const label = [...document.querySelectorAll('dt')].find((dt) => dt.textContent === 'Location');
    if (!label?.nextElementSibling) throw new Error('no Location row');
    return label.nextElementSibling;
}

test('a file two folders deep shows the drive and both folders, as a link to its parent', async () => {
    const value = await location(drivePath({ id: 'plan', name: 'plan.txt', mimeType: 'text/plain', parentId: 'year' }));
    expect(breadcrumbReads).toContain('year');
    expect(value.textContent).toBe('Drive › Projects › 2026');
    expect(value.querySelector('a')?.getAttribute('href')).toBe(getDriveItemUrl(year) ?? null);
});

test('a file at the root of a team drive shows the drive by its sidebar name', async () => {
    const value = await location(
        drivePath({
            id: 'brief',
            name: 'brief.txt',
            mimeType: 'text/plain',
            parentId: 'team-root',
            ownerId: teamOwnerId('t1'),
            mountId: 'm1',
        }),
    );
    expect(value.textContent).toBe('Design files');
    expect(value.querySelector('a')?.getAttribute('href')).toBe(getDriveItemUrl(teamRoot) ?? null);
});

test('a file shared without its folders shows its owner as the drive, and no link', async () => {
    const value = await location(
        drivePath({ id: 'memo', name: 'memo.txt', mimeType: 'text/plain', parentId: 'hidden', ownerId: 'alice' }),
    );
    expect(value.textContent).toBe('Alice Example');
    expect(value.querySelector('a')).toBeNull();
});
