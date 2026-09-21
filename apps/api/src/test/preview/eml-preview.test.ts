import { describe, expect, test } from 'bun:test';
import type { EmlPreview } from '@workspace/lib/types/preview';
import DOMPurify from 'isomorphic-dompurify';
import { ApiError } from '../../lib/core/errors';
import {
    EML_PREVIEW_MAX_ATTACHMENTS,
    EML_PREVIEW_MAX_HTML_BYTES,
    EML_PREVIEW_MAX_TEXT_CHARS,
} from '../../lib/core/transfer';
import { toTransferableText } from '../../lib/document/transform/protocol';
import { buildEmlPreviewPayload } from '../../lib/preview/eml-preview';

// The payload the quick look reads. Every value in it came from a file a stranger wrote, and its html is
// injected into a shadow root on the app's own origin — so the preview makes no request when it renders:
// the only reference that survives is a data: URI, and the only remote URL an <a href> the reader clicks.

const HOSTILE = 'evil.example';
const LINKED = 'ok.example';

const eml = (lines: string[]) => `${lines.join('\r\n')}\r\n`;

const htmlMessage = (body: string, extraHeaders: string[] = []) =>
    eml([
        'From: Sender <sender@external.com>',
        'To: Alice <alice@example.com>',
        'Subject: Hostile body',
        'Date: Tue, 15 Aug 2026 10:30:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        ...extraHeaders,
        '',
        body,
    ]);

const payloadOf = (text: string) => buildEmlPreviewPayload(toTransferableText(text));

// A recipient header reaches the payload as the parser hands it over: one object, or one per occurrence
// when the message repeats the header.
const addressesOf = (field: EmlPreview['to']) =>
    (Array.isArray(field) ? field : [field]).flatMap((one) => one?.value.map((v) => v.address) ?? []);

// One cid image, inlined by the parser, plus N references to it in the body.
const withInlineImage = (body: string, imageBytes: number, boundary = 'inline-image') =>
    eml([
        'From: sender@external.com',
        'To: alice@example.com',
        'Subject: Inline image',
        'MIME-Version: 1.0',
        `Content-Type: multipart/related; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        body,
        `--${boundary}`,
        'Content-Type: image/png',
        'Content-ID: <logo@eigen>',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: inline; filename="logo.png"',
        '',
        'A'.repeat(Math.ceil(imageBytes / 3) * 4),
        `--${boundary}--`,
    ]);

describe('buildEmlPreviewPayload', () => {
    test('the header fields a message shows reach the payload, and nothing else does', () => {
        const payload = payloadOf(
            eml([
                'From: Sender <sender@external.com>',
                'To: Alice <alice@example.com>, Bob <bob@example.com>',
                'Cc: Carol <carol@example.com>',
                'Bcc: Secret <secret@example.com>',
                'Subject: Quarterly report',
                'Date: Tue, 15 Aug 2026 10:30:00 +0000',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'The numbers are in.',
            ]),
        );

        expect(payload.subject).toBe('Quarterly report');
        expect(payload.from?.value[0]?.address).toBe('sender@external.com');
        expect(addressesOf(payload.to)).toEqual(['alice@example.com', 'bob@example.com']);
        expect(addressesOf(payload.cc)).toEqual(['carol@example.com']);
        expect(payload.date).toBe('2026-08-15T10:30:00.000Z');
        expect(payload.text).toContain('The numbers are in.');
        expect(payload.attachments).toEqual([]);
        expect(payload.remainingAttachments).toBe(0);
        expect(JSON.stringify(payload)).not.toContain('secret@example.com');
    });

    // A message that repeats a header carries one list per occurrence, and the reader shows every one of
    // them: a quick look that kept the last would silently drop recipients the message was addressed to.
    test('a repeated To: or Cc: keeps every recipient the message names', () => {
        const payload = payloadOf(
            eml([
                'From: sender@external.com',
                'To: Alice <alice@example.com>',
                'To: Bob <bob@example.com>',
                'Cc: Carol <carol@example.com>',
                'Cc: Dave <dave@example.com>',
                'Subject: Repeated headers',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'Everyone is on it.',
            ]),
        );

        expect(addressesOf(payload.to)).toEqual(['alice@example.com', 'bob@example.com']);
        expect(addressesOf(payload.cc)).toEqual(['carol@example.com', 'dave@example.com']);
    });

    test('a message with no subject, date or sender is a payload, not a failure', () => {
        const payload = payloadOf(eml(['Content-Type: text/plain', '', 'Bare.']));

        expect(payload.subject).toBe('');
        expect(payload.date).toBeNull();
        expect(payload.from).toBeNull();
        expect(payload.to).toBeNull();
        expect(payload.cc).toBeNull();
        expect(payload.html).toBeNull();
    });

    test('no hostile body leaves a remote reference anywhere but an <a href>', () => {
        const payload = payloadOf(
            htmlMessage(
                [
                    `<img src="https://${HOSTILE}/a.png">`,
                    `<img srcset="https://${HOSTILE}/2x.png 2x">`,
                    `<img srcset="data:image/png;base64,iVBORw0KGgo= 1x, https://${HOSTILE}/set.png 2x">`,
                    `<table background="https://${HOSTILE}/bg.png"><tr><td>cell</td></tr></table>`,
                    `<div style="background:url(https://${HOSTILE}/css.png)">styled</div>`,
                    `<div style="background:u\\72l(https://${HOSTILE}/escaped.png)">escaped</div>`,
                    `<div style='background-image:image-set("https://${HOSTILE}/set.png" 1x)'>set</div>`,
                    `<style>body{background-image:image-set("https://${HOSTILE}/sheet.png" 1x)}</style>`,
                    `<style>@import "https://${HOSTILE}/sheet.css";</style>`,
                    `<svg><image href="https://${HOSTILE}/svg.png"></image><feImage href="https://${HOSTILE}/fe.png"/></svg>`,
                    `<video poster="https://${HOSTILE}/poster.jpg"><track src="https://${HOSTILE}/t.vtt"></video>`,
                    `<audio src="https://${HOSTILE}/a.mp3"></audio>`,
                    `<picture><source srcset="https://${HOSTILE}/p.webp"><img src="https://${HOSTILE}/p.png"></picture>`,
                    '<math><mtext>formula</mtext></math>',
                    `<input type="image" src="https://${HOSTILE}/input.png">`,
                    `<form action="https://${HOSTILE}/post"><button>send</button></form>`,
                    `<base href="https://${HOSTILE}/">`,
                    `<link rel="stylesheet" href="https://${HOSTILE}/s.css">`,
                    `<meta http-equiv="refresh" content="0;url=https://${HOSTILE}/">`,
                    `<object data="https://${HOSTILE}/o"></object>`,
                    `<blockquote cite="https://${HOSTILE}/c">quoted</blockquote>`,
                    `<img usemap="https://${HOSTILE}/m" longdesc="https://${HOSTILE}/l">`,
                    `<a target="_top" ping="https://${HOSTILE}/ping" href="https://${LINKED}/page">a link</a>`,
                ].join('\n'),
            ),
        );

        // The html is the only field that becomes DOM: the text body is rendered as text, links and all.
        expect(payload.html).not.toContain(HOSTILE);
        expect(payload.html).toContain(`href="https://${LINKED}/page"`);
        // The words survive, so the message still reads.
        expect(payload.html).toContain('quoted');
    });

    // Beside the attribute rule: an element that fetches on its own, and a tree the URL rules do not
    // reach into, is not in a quick look at all.
    test('no media, form or foreign-namespace element survives the build', () => {
        const payload = payloadOf(
            htmlMessage(
                [
                    `<svg><image href="https://${HOSTILE}/svg.png"></image></svg>`,
                    `<math><mtext>formula</mtext></math>`,
                    `<video poster="https://${HOSTILE}/p.jpg"><track src="https://${HOSTILE}/t.vtt"></video>`,
                    `<audio src="https://${HOSTILE}/a.mp3"></audio>`,
                    `<picture><source srcset="https://${HOSTILE}/p.webp"><img src="https://${HOSTILE}/p.png"></picture>`,
                    `<input type="image" src="https://${HOSTILE}/i.png">`,
                    `<form action="https://${HOSTILE}/post"><button>send</button></form>`,
                ].join('\n'),
            ),
        );

        for (const tag of ['svg', 'math', 'video', 'audio', 'source', 'track', 'input', 'button', 'picture', 'form']) {
            expect(payload.html).not.toContain(`<${tag}`);
        }
    });

    // CSS does not need a closing paren to fetch: an unterminated `url(` at the end of a declaration, a
    // sheet or a quoted string still yields the url to the parser, so the opening token is what is refused.
    test('a url() that never closes, or closes on the wrong quote, is refused in both places CSS lives', () => {
        const declarations = [
            `background:url(https://${HOSTILE}/a`,
            `background:url(https://${HOSTILE}/b`,
            `cursor:url(https://${HOSTILE}/c.cur), pointer`,
            `background:url(  https://${HOSTILE}/spaced.png)`,
            `background:url('https://${HOSTILE}/quoted.png`,
            `background:url("https://${HOSTILE}/mismatched.png')`,
        ];
        const payload = payloadOf(
            htmlMessage(
                [
                    ...declarations.map((css, i) => `<div style="${css}">attr ${i}</div>`),
                    ...declarations.map((css, i) => `<style>.sheet${i}{${css}}</style>`),
                    `<style>@font-face{font-family:e;src:url(https://${HOSTILE}/f</style>`,
                ].join('\n'),
            ),
        );

        expect(payload.html).not.toContain(HOSTILE);
        expect(payload.html).toContain('attr 0');
    });

    // A client renders on a canvas of its own and drops the color-scheme rules that disagree with it
    // (ShadowContent, packages/ui), which rejoins a token split across such a block: neither half of
    // `ur@media (prefers-color-scheme: dark){}l(` is a token the raw text carries, and the deletion leaves
    // `url(`. The refusal reads the text such a deletion would leave behind as well as the raw text.
    test('a fetch token split across a prefers-color-scheme block is refused, whichever scheme it names', () => {
        const declarations = [
            `background:ur@media (prefers-color-scheme: dark){}l(https://${HOSTILE}/dark-pixel.png)`,
            `background:ur@media (prefers-color-scheme: light){}l(https://${HOSTILE}/light-pixel.png)`,
        ];
        const payload = payloadOf(
            htmlMessage(
                [
                    ...declarations.map((css, i) => `<div style="${css}">attr ${i}</div>`),
                    ...declarations.map((css) => `<style>p{${css}}</style>`),
                    `<style>@imp@media (prefers-color-scheme: dark){}ort "https://${HOSTILE}/dark.css";</style>`,
                    `<style>@imp@media (prefers-color-scheme: light){}ort "https://${HOSTILE}/light.css";</style>`,
                    '<p>hello</p>',
                ].join('\n'),
            ),
        );

        expect(payload.html).not.toContain(HOSTILE);
        // The CSS is all that is refused: the message still reads.
        expect(payload.html).toContain('hello');
    });

    // A data: reference is kept for the inline images a message really carries; an SVG or an HTML one is a
    // document tree of its own, and only the browser's SVG-as-image rules would stand between it and a fetch.
    test('only a raster data: image survives, in an attribute and in CSS', () => {
        const svg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E`;
        const payload = payloadOf(
            htmlMessage(
                [
                    `<img src="${svg}">`,
                    '<img src="data:text/html,<b>x</b>">',
                    `<div style="background:url(${svg})">svg css</div>`,
                    `<style>.html{background:url(data:text/html,<b>x</b>)}</style>`,
                    '<img src="data:image/png;base64,iVBORw0KGgo=">',
                    `<div style="background:url( 'data:image/jpeg;base64,/9j/4AAQ' )">quoted css</div>`,
                ].join('\n'),
            ),
        );

        expect(payload.html).not.toContain('svg+xml');
        expect(payload.html).not.toContain('text/html');
        expect(payload.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
        // The message keeps the images it really carries, however its CSS spells them.
        expect(payload.html).toContain("url( 'data:image/jpeg;base64,/9j/4AAQ' )");
    });

    test('every link opens in a new tab with no window handle, and only a clickable scheme survives', () => {
        const payload = payloadOf(
            htmlMessage(
                [
                    `<a href="https://${LINKED}/page">web</a>`,
                    '<a href="mailto:ada@example.com">mail</a>',
                    '<a href="javascript:alert(1)">script</a>',
                    '<a href="data:text/html,<b>x</b>">data</a>',
                ].join('\n'),
            ),
        );

        const html = payload.html ?? '';
        for (const anchor of html.match(/<a\b[^>]*>/g) ?? []) {
            expect(anchor).toContain('target="_blank"');
            expect(anchor).toContain('rel="noopener noreferrer"');
        }
        expect(html).toContain(`href="https://${LINKED}/page"`);
        expect(html).toContain('href="mailto:ada@example.com"');
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('data:text/html');
    });

    test('an inline cid image is served as the data: URI the parser built', () => {
        const payload = payloadOf(withInlineImage('<p>Logo: <img src="cid:logo@eigen"></p>', 1024));

        expect(payload.html).toContain('src="data:image/png;base64,');
        expect(payload.html).not.toContain('cid:');
    });

    // inlineCidImages copies the image's bytes once per reference, so a body can name one small image
    // enough times to blow the payload up on its own.
    test('one cid referenced hundreds of times leaves the payload under the html ceiling', () => {
        const references = 200;
        const imageBytes = 64 * 1024;
        const payload = payloadOf(withInlineImage('<img src="cid:logo@eigen">'.repeat(references), imageBytes));

        expect(references * imageBytes).toBeGreaterThan(EML_PREVIEW_MAX_HTML_BYTES);
        expect(payload.html).not.toContain('data:');
        expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(EML_PREVIEW_MAX_HTML_BYTES);
    });

    test('an inline image under the ceiling still shows', () => {
        const payload = payloadOf(withInlineImage('<img src="cid:logo@eigen">', 1024 * 1024));

        expect(payload.html).toContain('data:image/png;base64,');
    });

    // The ceiling is measured twice, so more inline bytes never show less of a message than fewer do.
    test('a body over the ceiling only through its images keeps the message and drops the images', () => {
        const payload = payloadOf(withInlineImage('<p>Logo: <img src="cid:logo@eigen"></p>', 3 * 1024 * 1024));

        expect(payload.html).toContain('Logo:');
        expect(payload.html).not.toContain('data:');
    });

    // A 12 MiB part costs 4.4 GB of RSS inside DOMPurify, so the ceiling binds the sanitizer's input, not its
    // output. A hook of our own counts the nodes it walks: the builder's hooks are added and popped after it.
    test('a body over the html ceiling is dropped before it is sanitized, and the text body carries the message', () => {
        const filler = `<p>${'word '.repeat(64)}</p>\r\n`;
        let nodesSanitized = 0;
        DOMPurify.addHook('afterSanitizeAttributes', () => {
            nodesSanitized += 1;
        });
        try {
            const payload = payloadOf(
                htmlMessage(filler.repeat(Math.ceil(EML_PREVIEW_MAX_HTML_BYTES / filler.length) + 512)),
            );

            expect(payload.html).toBeNull();
            expect(payload.text).toContain('word');
            expect(nodesSanitized).toBe(0);
        } finally {
            DOMPurify.removeHook('afterSanitizeAttributes');
        }
    });

    test('a long text body is cut to the payload ceiling', () => {
        const payload = payloadOf(
            eml([
                'From: sender@external.com',
                'Subject: Long',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'x'.repeat(EML_PREVIEW_MAX_TEXT_CHARS + 5000),
            ]),
        );

        expect(payload.text?.length).toBe(EML_PREVIEW_MAX_TEXT_CHARS);
    });

    test('the parts a message carries are listed by name, type and size, and the rest are counted', () => {
        const boundary = 'many-parts';
        const parts = Array.from({ length: EML_PREVIEW_MAX_ATTACHMENTS + 7 }, (_, i) =>
            [
                `--${boundary}`,
                'Content-Type: text/plain; charset=utf-8',
                `Content-Disposition: attachment; filename="part-${i}.txt"`,
                '',
                `body ${i}`,
            ].join('\r\n'),
        );
        const payload = payloadOf(
            eml([
                'From: sender@external.com',
                'Subject: Many parts',
                'MIME-Version: 1.0',
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                '',
                ...parts,
                `--${boundary}--`,
            ]),
        );

        expect(payload.attachments).toHaveLength(EML_PREVIEW_MAX_ATTACHMENTS);
        expect(payload.remainingAttachments).toBe(7);
        expect(payload.attachments[0]).toEqual({ filename: 'part-0.txt', contentType: 'text/plain', size: 6 });
        // No part bytes ride along: a preview reads a message, the byte routes serve its parts.
        expect(JSON.stringify(payload)).not.toContain('body 0');
    });

    test('a file the parser refuses is a controlled failure, not a throw the runner reports as a crash', () => {
        const oversizeHead = `X-Padding: ${'x'.repeat(1024 * 1024 + 16)}`;
        const read = () => payloadOf(eml([oversizeHead, 'Subject: Too big a head', '', 'body']));

        expect(read).toThrow(new ApiError(422, 'Could not read this file'));
    });
});
