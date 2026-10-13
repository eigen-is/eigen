// A band on the page is drawn read-only, live from its root, and only with content. The header sits 1.27 cm below the
// paper's top edge and the footer ends 1.27 cm above its bottom one, in the margin, and a band taller than its margin
// pushes the body. A click opens the panel on it, but for one on a link, which follows the link.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement } = await import('react');
const { useDocMedia } = await import('../../../components/docs/doc-editor');
const { AuthProvider } = await import('@workspace/lib/auth');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { PageBand } = await import('../../../components/docs/page-band');

type Props = Parameters<typeof PageBand>[0];

let unmount = async () => {};
afterEach(() => unmount());

async function render(doc: InstanceType<typeof Y.Doc>, props: Pick<Props, 'field' | 'edge' | 'margin' | 'onOpen'>) {
    function Band() {
        return createElement(PageBand, {
            media: useDocMedia(drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC })),
            yDoc: doc,
            ...props,
        });
    }
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Band))));
    const band = document.querySelector<HTMLElement>('[data-page-band]');
    if (!band) throw new Error('no band');
    return band;
}

function write(doc: InstanceType<typeof Y.Doc>, root: string, text: string, href?: string) {
    const paragraph = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, text, href ? { link: { href } } : {});
    paragraph.insert(0, [run]);
    doc.getXmlFragment(root).insert(doc.getXmlFragment(root).length, [paragraph]);
}

test('an empty band draws nothing, and draws once a collaborator writes it', async () => {
    const doc = new Y.Doc();
    const band = await render(doc, { field: 'header', edge: 'top', margin: 20 });
    expect(band.hidden).toBe(true);

    await act(async () => write(doc, 'header', 'Acme'));
    expect(band.hidden).toBe(false);
    expect(band.textContent).toBe('Acme');
    expect(band.querySelector('[contenteditable="true"]')).toBeNull();
});

test('the header starts 1.27 cm below the top edge and keeps the body below its margin', async () => {
    const doc = new Y.Doc();
    write(doc, 'header', 'Acme');
    const band = await render(doc, { field: 'header', edge: 'top', margin: 20 });
    expect([band.style.marginTop, band.style.minHeight]).toEqual(['calc(12.7mm - 20mm)', 'max(0mm, 20mm - 12.7mm)']);
});

test('the footer ends 1.27 cm above the bottom edge', async () => {
    const doc = new Y.Doc();
    write(doc, 'footer', 'Page');
    const band = await render(doc, { field: 'footer', edge: 'bottom', margin: 25.4 });
    expect([band.style.marginBottom, band.style.minHeight]).toEqual([
        'calc(12.7mm - 25.4mm)',
        'max(0mm, 25.4mm - 12.7mm)',
    ]);
});

test('a click opens the panel on the band', async () => {
    const doc = new Y.Doc();
    write(doc, 'footer', 'Page');
    const onOpen = mock(() => {});
    const band = await render(doc, { field: 'footer', edge: 'bottom', margin: 20, onOpen });
    await act(async () => band.querySelector('p')?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
});

test('a click on a link follows it and leaves the panel closed', async () => {
    const doc = new Y.Doc();
    write(doc, 'footer', 'eigen.is', 'https://eigen.is');
    const onOpen = mock(() => {});
    const band = await render(doc, { field: 'footer', edge: 'bottom', margin: 20, onOpen });
    const link = band.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://eigen.is');
    await act(async () => link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(onOpen).not.toHaveBeenCalled();
});
