// A visitor is someone without a login who opened a public link. The doc route runs the editors' visitor tests over the
// real route tree and editor, and its editor is read-only to a visitor. The visitor's comments column, ?chat= landing and
// Print work from the document alone.
import { afterAll, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import { unmountAllRoots } from '@workspace/ui/test/render-in-document';
import {
    editorVisitorTests,
    labelled,
    OWNER,
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

editorVisitorTests({ server, routeTree, urlOf: URL_OF, noun: 'doc' });

test('the editor itself is read-only to a visitor and a guest, and editable to a writer', async () => {
    const users = [
        null,
        { id: 'guest', email: 'guest@test.eigen.is', name: 'Guest', role: 'guest' },
        { id: 'bob', email: 'bob@test.eigen.is', name: 'Bob' },
    ];
    const states: (string | null | undefined)[] = [];
    for (const user of users) {
        session.user = user;
        await open(URL_OF('pub'));
        states.push(editable());
        await unmountAllRoots();
    }
    expect(states).toEqual(['false', 'false', 'true']);
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
    expect(document.querySelector('[data-slot="detail-column"]')?.textContent).toContain('Check the dates');
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
