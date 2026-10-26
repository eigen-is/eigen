// The reader shows a message without what it would fetch from elsewhere until Load images is clicked. The
// shadow root is closed, so the test borrows `attachShadow` to read the body MessageView hands ShadowContent.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The header's avatar reads the session.
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));

const { act, createElement, useState } = await import('react');
const { MessageView } = await import('../../../components/mail/message-view');

const HOST = 'tracker.example';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const HOSTILE = [
    `<img src="https://${HOST}/pixel.gif" width="1" height="1">`,
    `<img srcset="https://${HOST}/2x.png 2x">`,
    `<video poster="https://${HOST}/poster.jpg"></video>`,
    `<table><tbody><tr><td background="https://${HOST}/td.png">cell</td></tr></tbody></table>`,
    `<div style="background:url(https://${HOST}/css.png)">styled</div>`,
    `<style>.hero{background:url(https://${HOST}/hero.png)}.wide{width:600px}</style>`,
    `<p>Logo: <img src="${PNG}" alt="logo"></p>`,
].join('');

let unmount = async () => {};
let shadowRoot: ShadowRoot | null = null;
const attach = HTMLElement.prototype.attachShadow;
HTMLElement.prototype.attachShadow = function attachShadowSpy(init: ShadowRootInit) {
    shadowRoot = attach.call(this, init);
    return shadowRoot;
};

afterEach(async () => {
    await unmount();
    shadowRoot = null;
});

const shownBody = () => shadowRoot?.querySelector('.shadow-content-container')?.innerHTML ?? '';
const loadButton = () =>
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Load images');

// The reader's own wiring: blocked until the click, then the message as it came.
function Reader({ html }: { html: string }) {
    const [loaded, setLoaded] = useState(false);
    return createElement(MessageView, {
        subject: 'Newsletter',
        html,
        remoteImagesLoaded: loaded,
        onLoadRemoteImages: () => setLoaded(true),
    });
}

test('a remote reference in any place the reader renders is held back, behind one muted line', async () => {
    ({ unmount } = await renderInDocument(createElement(Reader, { html: HOSTILE })));

    expect(shownBody()).not.toContain(HOST);
    expect(shownBody()).toContain('cell');
    expect(shownBody()).toContain('.wide{width:600px}');
    // The image the message carries inline is not remote.
    expect(shownBody()).toContain(`src="${PNG}"`);
    expect(document.body.textContent).toContain('Remote images are hidden.');
    expect(loadButton()).toBeDefined();
});

test('Load images shows the message as it came, and the line goes', async () => {
    ({ unmount } = await renderInDocument(createElement(Reader, { html: HOSTILE })));

    await act(async () => loadButton()?.click());

    expect(shownBody()).toContain(`src="https://${HOST}/pixel.gif"`);
    expect(shownBody()).toContain(`url(https://${HOST}/hero.png)`);
    expect(document.body.textContent).not.toContain('Remote images are hidden.');
});

test('a message with only inline images shows no line', async () => {
    const html = `<p>Logo: <img src="${PNG}" alt="logo"></p>`;
    ({ unmount } = await renderInDocument(createElement(Reader, { html })));

    expect(shownBody()).toContain(`src="${PNG}"`);
    expect(loadButton()).toBeUndefined();
});

test('without a Load images callback the body is still held back, and the line offers no button', async () => {
    ({ unmount } = await renderInDocument(createElement(MessageView, { subject: 'Preview', html: HOSTILE })));

    expect(shownBody()).not.toContain(HOST);
    expect(document.body.textContent).toContain('Remote images are hidden.');
    expect(loadButton()).toBeUndefined();
});

test('a body the .eml preview served, stripped on the server, shows no line', async () => {
    const html = `<p>Logo: <img src="${PNG}" alt="logo"></p><a href="https://example.com/page" target="_blank" rel="noopener noreferrer">read more</a>`;
    ({ unmount } = await renderInDocument(createElement(MessageView, { subject: 'Preview', html })));

    expect(shownBody()).toContain('read more');
    expect(document.body.textContent).not.toContain('Remote images are hidden.');
});
