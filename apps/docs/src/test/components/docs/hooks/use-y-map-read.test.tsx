// The editor's page and Normal are the doc's root maps as any peer leaves them, read through their readers.
import { afterEach, expect, test } from 'bun:test';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const Y = await import('yjs');
const { DEFAULT_PAGE_SETUP, PAGE_ROOT, pageRecord, readPageSetup } = await import('@workspace/lib/docs/eigendoc');
const { useYMapRead } = await import('../../../../components/docs/hooks/use-y-map-read');

const LETTER_LANDSCAPE: PageSetup = {
    width: 279.4,
    height: 215.9,
    margin: { top: 25.4, right: 12.7, bottom: 25.4, left: 30 },
    headerDistance: 15,
    footerDistance: 10,
    differentFirstPage: false,
    pageless: false,
};

let unmount = async () => {};
afterEach(() => unmount());

let seen: PageSetup[] = [];
function Probe({ doc, onRender }: { doc: InstanceType<typeof Y.Doc>; onRender?: () => void }) {
    seen.push(useYMapRead(doc.getMap(PAGE_ROOT), readPageSetup));
    onRender?.();
    return null;
}

test('a page change a peer writes reaches the editor through the synced doc', async () => {
    const local = new Y.Doc();
    const peer = new Y.Doc();
    seen = [];
    ({ unmount } = await renderInDocument(createElement(Probe, { doc: local })));
    expect(seen.at(-1)).toEqual(DEFAULT_PAGE_SETUP);

    peer.transact(() => {
        for (const [key, value] of Object.entries(pageRecord(LETTER_LANDSCAPE))) peer.getMap(PAGE_ROOT).set(key, value);
    });
    await act(async () => Y.applyUpdate(local, Y.encodeStateAsUpdate(peer)));
    expect(seen.at(-1)).toEqual(LETTER_LANDSCAPE);

    // A forged value reads as the default, never as itself.
    peer.getMap(PAGE_ROOT).set('width', '1e9');
    await act(async () => Y.applyUpdate(local, Y.encodeStateAsUpdate(peer)));
    expect(seen.at(-1)?.width).toBe(DEFAULT_PAGE_SETUP.width);
});

test('a change that lands between the first render and the subscription still reaches the editor', async () => {
    const doc = new Y.Doc();
    seen = [];
    const onRender = () => {
        if (seen.length === 1) doc.getMap(PAGE_ROOT).set('width', 148);
    };
    ({ unmount } = await renderInDocument(createElement(Probe, { doc, onRender })));
    expect(seen[0]?.width).toBe(DEFAULT_PAGE_SETUP.width);
    expect(seen.at(-1)?.width).toBe(148);
});
