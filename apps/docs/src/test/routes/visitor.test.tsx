// A visitor is someone without a login who opened a public link. The doc route renders for them over the real route
// tree and editor, against a server that answers only the routes a public link opens: read-only, with no share, no
// activity and only the routes on that list asked. A private doc sends them to log in with the way back, and a
// signed-in user's and a guest's editor still read the comment index the visitor never asks for. The visitor's
// comments pane, ?chat= landing and Print work from the document alone.
import { afterAll, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import {
    labelled,
    OWNER,
    providers,
    session,
    visitorServer,
    withProviders,
    withSession,
} from '@workspace/ui/test/visitor-server';
import * as Y from 'yjs';

const server = visitorServer({ type: 'doc', mimeType: DRIVE_MIME_DOC, name: 'Holiday.eigendoc' });

const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCollab = { ...(await import('@workspace/lib/collab')) };
mock.module('@workspace/lib/collab', () => withProviders(realCollab));
mock.module('@workspace/lib/auth', () => withSession(realAuth));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act } = await import('react');
const { routeTree } = await import('../../routeTree.gen');
const open = (url: string, seed?: (doc: Y.Doc) => void) => server.open(routeTree, url, seed);

// A stored comment on the doc's one paragraph, its thread in the chat folder the visitor's listing never holds.
function commented(doc: Y.Doc) {
    const card = new Y.Map<unknown>();
    card.set('title', 'Check the dates');
    card.set('chatName', 'dates.eigenchat');
    doc.getMap('comments').set('c1', card);
    const paragraph = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, 'Hello', { comment: { cardId: 'c1' } });
    paragraph.insert(0, [run]);
    doc.getXmlFragment('default').insert(0, [paragraph]);
}

const URL_OF = (pathId: string) => `/doc/${OWNER}/default/${pathId}`;
const editable = () => document.querySelector('.ProseMirror:not(.page-band)')?.getAttribute('contenteditable');

test('a visitor reads a public doc, with its name in the bar, and asks only for what the link opens', async () => {
    const router = await open(URL_OF('pub'));
    expect(router.state.location.pathname).toBe(URL_OF('pub'));
    expect(editable()).toBe('false');
    expect(document.querySelector('header')?.textContent).toContain('Holiday');
    expect(labelled('Log in')).not.toBeNull();
    expect(labelled('Share')).toBeNull();
    expect(labelled('Activity')).toBeNull();
    expect(server.outsideTheLink()).toEqual([]);
    // No presence: with no local state y-websocket sends no awareness, and a cursor set later does nothing.
    expect([...providers].map((provider) => provider.awareness.getLocalState())).toEqual([null]);
    // The guard's read, and none from a share dialog.
    expect(server.permissionReads()).toEqual([`/drive/${OWNER}/default/path/pub/permissions`]);
});

test('a visitor lands on login, with the way back, for a doc the link does not open', async () => {
    const router = await open(URL_OF('secret'));
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({ redirect: URL_OF('secret') });
});

test("a signed-in writer's doc is editable, offers Share and reads the comment index", async () => {
    session.user = { id: 'bob', email: 'bob@test.eigen.is', name: 'Bob' };
    await open(URL_OF('pub'));
    expect(editable()).toBe('true');
    expect(labelled('Share')).not.toBeNull();
    expect(labelled('Activity')).not.toBeNull();
    expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
    expect([...providers].every((provider) => provider.awareness.getLocalState() !== null)).toBe(true);
});

test("a guest's doc still reads the comment index and the members", async () => {
    session.user = { id: 'guest', email: 'guest@test.eigen.is', name: 'Guest', role: 'guest' };
    await open(URL_OF('pub'));
    expect(editable()).toBe('false');
    expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
    expect(server.requested).toContain(`/drive/${OWNER}/default/path/pub/effective-members`);
});

test('a visitor opens the comments and reads a stored card, asking for nothing the link does not open', async () => {
    await open(URL_OF('pub'), commented);
    await act(async () => {
        labelled('Comments')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // The pane reads the anchors 200 ms after the body's last change.
        await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(document.body.textContent).toContain('Check the dates');
    expect(server.outsideTheLink()).toEqual([]);
});

test("a visitor's ?chat= link opens the card it names", async () => {
    await open(`${URL_OF('pub')}?chat=dates.eigenchat`, commented);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Check the dates');
    expect(server.outsideTheLink()).toEqual([]);
});

test("a visitor's File › Print prints in the browser and asks the server for nothing", async () => {
    let prints = 0;
    window.print = () => prints++;
    await open(URL_OF('pub'));
    const asked = server.requested.length;
    const file = [...document.querySelectorAll('button')].find((button) => button.textContent === 'File');
    await act(async () => file?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
    const print = [...document.querySelectorAll('[role="menuitem"]')].find((row) =>
        row.textContent?.trim().startsWith('Print'),
    );
    await act(async () => {
        print?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(prints).toBe(1);
    expect(server.requested.length).toBe(asked);
});
