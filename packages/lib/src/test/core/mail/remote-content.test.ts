import { describe, expect, test } from 'bun:test';
import { cssFetches, restrictSheet, stripRemoteContent } from '../../../core/mail/remote-content';
import { installHappyDom } from '../../happy-dom';

// The reader's strip parses with DOMParser.
installHappyDom();

const HOST = 'tracker.example';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('cssFetches', () => {
    test('every token that fetches is refused, however it is spelled', () => {
        for (const css of [
            `background:url(https://${HOST}/a.png)`,
            `background:URL( "https://${HOST}/b.png" )`,
            `background:u\\72l(https://${HOST}/escaped.png)`,
            `background:url(https://${HOST}/unterminated`,
            `@import "https://${HOST}/sheet.css"`,
            `background-image:image-set("https://${HOST}/set.png" 1x)`,
            `background-image:-webkit-image-set("https://${HOST}/set.png" 1x)`,
            `background:cross-fade(url(${PNG}), url(${PNG}), 50%)`,
            `background:url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E)`,
            // A viewer that drops a color-scheme block rejoins what surrounds it.
            `background:ur@media (prefers-color-scheme: dark){}l(https://${HOST}/dark.png)`,
            `@imp@media (prefers-color-scheme: light){}ort "https://${HOST}/light.css"`,
        ]) {
            expect(cssFetches(css)).toBe(true);
        }
    });

    test('a raster data: image and plain layout fetch nothing', () => {
        expect(cssFetches(`background:url(${PNG})`)).toBe(false);
        expect(cssFetches(`background:url( 'data:image/jpeg;base64,/9j/4AAQ' )`)).toBe(false);
        expect(cssFetches('color:#333;width:600px;font-family:Arial,sans-serif')).toBe(false);
    });
});

describe('restrictSheet', () => {
    test('only the statements that fetch go', () => {
        const sheet = `.hero{background:url(https://${HOST}/hero.png)}.wide{width:900px}@import "https://${HOST}/s.css";@media (max-width:600px){.wide{width:100%}}`;
        expect(restrictSheet(sheet)).toBe('.wide{width:900px}@media (max-width:600px){.wide{width:100%}}');
    });

    test('a sheet that fetches nothing comes back as it was', () => {
        const sheet = 'p{margin:0} @media (max-width:600px){.wide{width:100%}}';
        expect(restrictSheet(sheet)).toBe(sheet);
    });
});

describe('stripRemoteContent', () => {
    test('every remote reference the reader would fetch on render is gone, and the message still reads', () => {
        const vectors = [
            `<img src="https://${HOST}/pixel.gif" width="1" height="1">`,
            `<img srcset="https://${HOST}/2x.png 2x">`,
            `<img srcset="${PNG} 1x, https://${HOST}/set.png 2x">`,
            `<picture><source srcset="https://${HOST}/p.webp"><img src="https://${HOST}/p.png"></picture>`,
            `<video poster="https://${HOST}/poster.jpg" src="https://${HOST}/v.mp4"><track src="https://${HOST}/t.vtt"></video>`,
            `<audio src="https://${HOST}/a.mp3"></audio>`,
            `<table background="https://${HOST}/bg.png"><tbody><tr><td background="https://${HOST}/td.png">cell</td></tr></tbody></table>`,
            `<input type="image" src="https://${HOST}/input.png">`,
            `<div style="background:url(https://${HOST}/css.png)">styled</div>`,
            `<div style="background:u\\72l(https://${HOST}/escaped.png)">escaped</div>`,
            `<style>.a{background:url(https://${HOST}/sheet.png)}</style>`,
            `<style>@import "https://${HOST}/sheet.css";</style>`,
            `<svg><feImage href="https://${HOST}/fe.png"></feImage><rect fill="url(https://${HOST}/paint.svg#p)" mask="url(https://${HOST}/m.svg#m)"></rect></svg>`,
            `<object data="https://${HOST}/o"></object>`,
        ];
        const { html, blocked } = stripRemoteContent(`${vectors.join('\n')}<p>hello</p>`);
        expect(blocked).toBe(true);
        expect(html).not.toContain(HOST);
        expect(html).toContain('hello');
        expect(html).toContain('cell');
        // The pixel keeps its box, so a newsletter's layout holds.
        expect(html).toContain('<img width="1" height="1">');
    });

    test('each vector alone is blocked', () => {
        for (const vector of [
            `<img src="https://${HOST}/a.png">`,
            `<img srcset="https://${HOST}/a.png 2x">`,
            `<video poster="https://${HOST}/p.jpg"></video>`,
            `<table><tbody><tr><td background="https://${HOST}/td.png">x</td></tr></tbody></table>`,
            `<p style="background-image:url('https://${HOST}/a.png')">x</p>`,
            `<style>p{background:url(https://${HOST}/a.png)}</style><p>x</p>`,
            `<svg><rect fill="url(https://${HOST}/p.svg#p)"></rect></svg>`,
        ]) {
            const { html, blocked } = stripRemoteContent(vector);
            expect(blocked).toBe(true);
            expect(html).not.toContain(HOST);
        }
    });

    test('a srcset is never inline, even when it names only data: images', () => {
        const { html, blocked } = stripRemoteContent(`<img src="${PNG}" srcset="${PNG} 1x">`);
        expect(blocked).toBe(true);
        expect(html).toBe(`<img src="${PNG}">`);
    });

    test('a raster data: image the parser inlined from a cid: part stays, and nothing is blocked', () => {
        const body = `<p>Logo: <img src="${PNG}" alt="logo"></p><div style="background:url(${PNG})">x</div>`;
        expect(stripRemoteContent(body)).toEqual({ html: body, blocked: false });
    });

    test('an inlined SVG waits for the click like a remote image', () => {
        const { html, blocked } = stripRemoteContent('<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">');
        expect(blocked).toBe(true);
        expect(html).not.toContain('svg+xml');
    });

    test('a link keeps its href: a click is what fetches it', () => {
        const body = `<a href="https://${HOST}/page" target="_blank">read more</a>`;
        expect(stripRemoteContent(body)).toEqual({ html: body, blocked: false });
    });

    test('a message with nothing remote comes back as the same string', () => {
        // Unnormalized on purpose: a re-serialize would quote the attribute and close the <p>.
        const body = '<style>p{margin:0}</style><p class=intro>hello<br>world';
        expect(stripRemoteContent(body)).toEqual({ html: body, blocked: false });
    });

    test('a leading <style> stays in the body the reader renders', () => {
        const { html } = stripRemoteContent(
            `<style>p{color:red}.x{background:url(https://${HOST}/a.png)}</style><p>x</p>`,
        );
        expect(html).toBe('<style>p{color:red}</style><p>x</p>');
    });
});
