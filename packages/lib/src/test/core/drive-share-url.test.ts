// The link Copy link puts on the clipboard. Production leaves the app URLs unset, so every app link is a same-origin
// path, and a pasted path opens nothing outside the page: the share URL carries the page's origin.
import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';

installHappyDom();

const { getDriveShareUrl } = await import('../../core/api');
const { DRIVE_TYPE_DOC, DRIVE_TYPE_FILE } = await import('../../types/drive');

const doc = { id: 'p1', mountId: 'm1', ownerId: 'o1', name: 'Plan', type: DRIVE_TYPE_DOC, mimeType: '' };
const file = { ...doc, type: DRIVE_TYPE_FILE, mimeType: 'application/zip', name: 'backup.zip' };

describe('getDriveShareUrl', () => {
    test('an openable item is an absolute link on the page origin', () => {
        const url = new URL(getDriveShareUrl(doc));
        expect(url.origin).toBe('http://localhost:3000');
        expect(url.pathname).toEndWith('/doc/o1/m1/p1');
    });

    test('a plain file is an absolute link to Drive with the item selected', () => {
        const url = new URL(getDriveShareUrl(file));
        expect(url.origin).toBe('http://localhost:3000');
        expect(url.searchParams.get('pid')).toBe('p1');
    });

    test('a comment thread keeps its chat', () => {
        expect(new URL(getDriveShareUrl(doc, { chat: 'c1' })).searchParams.get('chat')).toBe('c1');
    });
});
