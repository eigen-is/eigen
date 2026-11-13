import { describe, expect, test } from 'bun:test';
import { DELETE_HOTKEY } from '../../../constants/hotkeys';
import { driveActionsFor } from '../../../core/drive/drive-actions';
import type { DrivePath } from '../../../types/drive';
import type { DriveActionId, DriveActionSubject } from '../../../types/drive-actions';
import type { DriveCapabilities } from '../../../types/drive-view';

function path(p: Partial<DrivePath> & { name: string }): DrivePath {
    return {
        id: 'path-1',
        mountId: 'mount-1',
        type: 'file',
        parentId: 'parent-1',
        ownerId: 'owner-1',
        mimeType: 'application/octet-stream',
        size: 1024,
        hash: null,
        thumbnail: null,
        acl: null,
        visibility: 'private',
        sharingRestricted: false,
        details: null,
        trashedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...p,
    };
}

// The three presets the UI declares, spelled out: lib can't import them, and the gates read only these flags.
const browse: DriveCapabilities = {
    canCreateFolder: true,
    canUpload: true,
    canWrite: true,
    canDelete: true,
    canRename: true,
    canMove: true,
    canShare: true,
    showBreadcrumb: true,
};
const listing: DriveCapabilities = { ...browse, canCreateFolder: false, canUpload: false, canMove: false };
const readOnly: DriveCapabilities = {
    ...listing,
    canWrite: false,
    canDelete: false,
    canRename: false,
    canShare: false,
};

const pdf = path({ name: 'Report.pdf', mimeType: 'application/pdf' });
const doc = path({ name: 'Notes.eigendoc', type: 'doc', mimeType: 'application/eigendoc' });
const folder = path({ name: 'Photos', type: 'folder', mimeType: 'folder' });
const root = path({ name: 'My Drive', type: 'folder', mimeType: 'folder', parentId: null });
const sharedDoc = path({ ...doc, acl: [{ id: 'friend@example.com', read: true, write: false }] });

function idsFor(subject: Partial<DriveActionSubject> & { items: DrivePath[] }): DriveActionId[] {
    return driveActionsFor({ capabilities: browse, isSharedWithMe: () => false, ...subject }).map(
        (action) => action.id,
    );
}

describe('driveActionsFor on one item', () => {
    test('browse offers every row a document has, in catalog order', () => {
        expect(idsFor({ items: [doc] })).toEqual([
            'open',
            'open-new-tab',
            'rename',
            'duplicate',
            'move-to',
            'copy-to',
            'download-as',
            'share',
            'copy-link',
            'mail-to',
            'trash',
        ]);
    });

    test('a plain file has no Open, no new tab and no export formats', () => {
        const ids = idsFor({ items: [pdf] });
        expect(ids).not.toContain('open');
        expect(ids).not.toContain('open-new-tab');
        expect(ids).not.toContain('download-as');
    });

    test('a listing offers Duplicate but no Move to', () => {
        const ids = idsFor({ items: [doc], capabilities: listing });
        expect(ids).toContain('duplicate');
        expect(ids).not.toContain('move-to');
        expect(ids).toContain('copy-to');
    });

    test('read-only keeps only what reading allows', () => {
        expect(idsFor({ items: [doc], capabilities: readOnly })).toEqual([
            'open',
            'open-new-tab',
            'copy-to',
            'download-as',
            'copy-link',
            'mail-to',
        ]);
    });

    test('a root folder is never duplicated', () => {
        expect(idsFor({ items: [root] })).not.toContain('duplicate');
        expect(idsFor({ items: [folder] })).toContain('duplicate');
    });

    test('Email collaborators needs an item someone else can see', () => {
        expect(idsFor({ items: [doc] })).not.toContain('email-collaborators');
        expect(idsFor({ items: [sharedDoc] })).toContain('email-collaborators');
        expect(idsFor({ items: [path({ ...doc, visibility: 'public-read' })] })).toContain('email-collaborators');
        expect(idsFor({ items: [sharedDoc], capabilities: readOnly })).not.toContain('email-collaborators');
    });

    test('an item shared with the viewer is removed, never trashed', () => {
        const ids = idsFor({ items: [sharedDoc], isSharedWithMe: () => true });
        expect(ids).toContain('remove-shared');
        expect(ids).not.toContain('trash');
    });

    test('an item shared with the viewer is not duplicated, as its copy would land in the owner’s folder', () => {
        expect(idsFor({ items: [sharedDoc], isSharedWithMe: () => true })).not.toContain('duplicate');
    });

    test('no delete without canDelete', () => {
        const caps = { ...browse, canDelete: false };
        expect(idsFor({ items: [doc], capabilities: caps })).not.toContain('trash');
        expect(idsFor({ items: [sharedDoc], capabilities: caps, isSharedWithMe: () => true })).not.toContain(
            'remove-shared',
        );
    });

    test('rename follows canRename, share follows canShare', () => {
        expect(idsFor({ items: [doc], capabilities: { ...browse, canRename: false } })).not.toContain('rename');
        const ids = idsFor({ items: [doc], capabilities: { ...browse, canShare: false } });
        expect(ids).not.toContain('share');
        expect(ids).toContain('copy-link');
    });
});

describe('driveActionsFor on a multi-selection', () => {
    const items = [doc, pdf];

    test('offers only the rows that act on a set', () => {
        expect(idsFor({ items })).toEqual(['duplicate', 'move-to', 'copy-to', 'mail-to', 'trash']);
    });

    test('a set shared with the viewer is removed', () => {
        expect(idsFor({ items, isSharedWithMe: () => true })).toEqual([
            'move-to',
            'copy-to',
            'mail-to',
            'remove-shared',
        ]);
    });

    // A copy of the shared item would land in its owner's folder, and the trash row still fits the own item.
    test('a set with one item shared with the viewer is trashed but not duplicated', () => {
        const ids = idsFor({ items: [doc, sharedDoc], isSharedWithMe: (item) => item === sharedDoc });
        expect(ids).toEqual(['move-to', 'copy-to', 'mail-to', 'trash']);
    });

    test('a set with a root in it is not duplicated', () => {
        expect(idsFor({ items: [doc, root] })).not.toContain('duplicate');
    });

    test('read-only copies out and mails', () => {
        expect(idsFor({ items, capabilities: readOnly })).toEqual(['copy-to', 'mail-to']);
    });

    test('every row a set gets has a plural label with its count', () => {
        for (const action of driveActionsFor({ items, capabilities: browse, isSharedWithMe: () => false })) {
            expect(action.pluralLabel).toContain('{n}');
        }
    });
});

test('no items offer no rows', () => {
    expect(idsFor({ items: [] })).toEqual([]);
});

// A shared document in a browse view offers every row, the delete row aside, which turns on the share.
const everyRow = (sharedWithMe: boolean) =>
    driveActionsFor({ items: [sharedDoc], capabilities: browse, isSharedWithMe: () => sharedWithMe });

test('the guest and mail flags sit on the rows whose routes need them', () => {
    const flagged = (flag: 'guestDenied' | 'mailOnly') =>
        everyRow(false)
            .filter((a) => a[flag])
            .map((a) => a.id);
    expect(flagged('guestDenied')).toEqual(['email-collaborators']);
    expect(flagged('mailOnly')).toEqual(['mail-to']);
});

test('the deleting rows show the delete key, and no other row shows one', () => {
    const shortcuts = [...everyRow(false), ...everyRow(true)].filter((a) => a.shortcut).map((a) => [a.id, a.shortcut]);
    expect(shortcuts).toEqual([
        ['trash', DELETE_HOTKEY],
        ['remove-shared', DELETE_HOTKEY],
    ]);
});
