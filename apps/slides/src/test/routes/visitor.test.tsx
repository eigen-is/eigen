// A visitor is someone without a login who opened a public link. The slide route runs the editors' visitor tests over
// the real route tree and editor.
import { afterAll, mock } from 'bun:test';
import { DRIVE_MIME_SLIDES } from '@workspace/lib/types/drive';
import {
    editorVisitorTests,
    OWNER,
    visitorServer,
    withProviders,
    withSession,
} from '@workspace/ui/test/visitor-server';

const server = visitorServer({ type: 'slides', mimeType: DRIVE_MIME_SLIDES, name: 'Holiday.eigenslides' });

const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCollab = { ...(await import('@workspace/lib/collab')) };
mock.module('@workspace/lib/collab', () => withProviders(realCollab));
mock.module('@workspace/lib/auth', () => withSession(realAuth));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { routeTree } = await import('../../routeTree.gen');

editorVisitorTests({ server, routeTree, urlOf: (pathId) => `/slide/${OWNER}/default/${pathId}`, noun: 'deck' });
