// A fake API for the editors' route tests. It answers a visitor, someone without a login, only on the routes a public
// link opens, as the API's linkAuth lists them, and 401s the rest; a signed-in user gets every route. The document it
// holds is public or private, and every request is recorded, so a test can say that a visitor asked for nothing more.
// The collab socket never opens: a test marks the editor's provider synced itself.
import { afterAll, beforeEach } from 'bun:test';
import { CONTAINER_MEDIA_FOLDER } from '@workspace/lib/constants/container';
import type { AuthUser } from '@workspace/lib/types/auth';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from './drive-path';

const VISITOR_ROUTES = [
    /^\/drive\/[^/]+\/[^/]+\/path\/[^/]+(\/breadcrumb|\/permissions)?$/,
    /^\/drive\/[^/]+\/[^/]+\/folder\/[^/]+$/,
    /^\/drive\/[^/]+\/[^/]+\/file\/[^/]+\/(download|embed\/.+|preview|text-preview|vcard-preview|eml-preview|ics-preview)$/,
    /^\/drive\/[^/]+\/[^/]+\/thumb\/.+$/,
    /^\/collab\/[^/]+\/[^/]+\/[^/]+\/info$/,
    /^\/p\//,
];

export const isVisitorRoute = (pathname: string) => VISITOR_ROUTES.some((route) => route.test(pathname));

export const OWNER = 'alice'.padEnd(32, '0');

// The signed-in user of a test, or null for a visitor; a guest is a user with that role.
export const session: { user: (Pick<AuthUser, 'id' | 'email' | 'name'> & { role?: string }) | null } = { user: null };

export function sessionAuth() {
    const user = session.user && { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
    return {
        isAuthenticated: !!user,
        isLoading: false,
        user,
        login: async () => ({ success: true }),
        logout: async () => {},
    };
}

// The public document `pub` of the given type, with its media folder, which is all a visitor's listing of it holds.
export function visitorServer(document: Pick<DrivePath, 'type' | 'mimeType' | 'name'>) {
    const doc = drivePath({ ...document, id: 'pub', ownerId: OWNER, parentId: 'alice-root', visibility: 'link' });
    const media = drivePath({
        id: 'media',
        name: CONTAINER_MEDIA_FOLDER,
        ownerId: OWNER,
        type: 'folder',
        mimeType: DRIVE_MIME_FOLDER,
        parentId: 'pub',
    });
    const requested: string[] = [];

    function serve(pathname: string): Response {
        if (!session.user && !isVisitorRoute(pathname))
            return Response.json({ message: 'Unauthorized' }, { status: 401 });
        const permissions = pathname.match(/\/path\/([^/]+)\/permissions$/);
        if (permissions) return Response.json({ canRead: permissions[1] === 'pub', canWrite: false });
        const info = pathname.match(/^\/collab\/[^/]+\/[^/]+\/([^/]+)\/info$/);
        if (info) {
            if (info[1] !== 'pub')
                return Response.json({ canRead: false, canWrite: false, path: null, folderContents: null });
            // A visitor and a guest read; the owner's colleague, the test's other user, writes.
            const canWrite = !!session.user && session.user.role !== 'guest';
            return Response.json({ canRead: true, canWrite, path: doc, folderContents: [media] });
        }
        if (pathname.startsWith('/p/')) return Response.json({});
        if (pathname.endsWith('/unread-count')) return Response.json({ count: 0 });
        if (pathname.endsWith('/watch')) return Response.json({ direct: false, viaAncestor: null });
        return Response.json([]);
    }

    // biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
    const g = globalThis as any;
    const realFetch = g.fetch;
    const realWebSocket = g.WebSocket;
    beforeEach(() => {
        g.WebSocket = SilentWebSocket;
        requested.length = 0;
        g.fetch = async (input: string | URL | Request) => {
            const pathname = new URL(typeof input === 'object' && 'url' in input ? input.url : input).pathname;
            requested.push(pathname);
            return serve(pathname);
        };
    });
    afterAll(() => {
        g.fetch = realFetch;
        g.WebSocket = realWebSocket;
    });

    return {
        doc,
        requested,
        outsideTheLink: () => requested.filter((pathname) => !isVisitorRoute(pathname)),
        permissionReads: () => requested.filter((pathname) => pathname.endsWith('/permissions')),
    };
}

// A socket that stays connecting, so y-websocket sends nothing and never reconnects.
class SilentWebSocket {
    public binaryType = 'arraybuffer';
    public readyState = 0;
    public send() {}
    public close() {}
}
