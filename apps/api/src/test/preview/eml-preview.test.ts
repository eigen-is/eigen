import { describe, expect, test } from 'bun:test';
import {
    EML_PREVIEW_MAX_ATTACHMENTS,
    EML_PREVIEW_MAX_HTML_BYTES,
    EML_PREVIEW_MAX_INLINE_BYTES,
    EML_PREVIEW_MAX_TEXT_CHARS,
} from '@workspace/lib/constants/mail';
import { ApiError } from '../../lib/core/errors';
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
        expect(payload.to?.value.map((v) => v.address)).toEqual(['alice@example.com', 'bob@example.com']);
        expect(payload.cc?.value[0]?.address).toBe('carol@example.com');
        expect(payload.date).toBe('2026-08-15T10:30:00.000Z');
        expect(payload.text).toContain('The numbers are in.');
        expect(payload.attachments).toEqual([]);
        expect(payload.droppedAttachments).toBe(0);
        expect(JSON.stringify(payload)).not.toContain('secret@example.com');
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
    test('one cid referenced hundreds of times leaves the payload under the inline budget', () => {
        const references = 200;
        const imageBytes = 64 * 1024;
        const payload = payloadOf(withInlineImage('<img src="cid:logo@eigen">'.repeat(references), imageBytes));

        expect(references * imageBytes).toBeGreaterThan(EML_PREVIEW_MAX_INLINE_BYTES);
        expect(payload.html).not.toContain('data:');
        expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(EML_PREVIEW_MAX_INLINE_BYTES);
    });

    test('an inline image under the budget still shows', () => {
        const payload = payloadOf(withInlineImage('<img src="cid:logo@eigen">', 1024));

        expect(payload.html).toContain('data:image/png;base64,');
    });

    test('a body over the html ceiling is dropped, and the text body carries the message instead', () => {
        const filler = `<p>${'word '.repeat(64)}</p>\r\n`;
        const payload = payloadOf(
            htmlMessage(filler.repeat(Math.ceil(EML_PREVIEW_MAX_HTML_BYTES / filler.length) + 512)),
        );

        expect(payload.html).toBeNull();
        expect(payload.text).toContain('word');
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
        expect(payload.droppedAttachments).toBe(7);
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
