// A link dialog stores what webLinkHref makes of an address: it adds https to an address without a scheme, and refuses
// one no browser opens, such as a scripting scheme or a host with a space in it. Every reader opens a stored address
// through resolveWebLink, so an imported or peer-written one with spaces around it still opens.
import { expect, test } from 'bun:test';
import { resolveWebLink, webLinkHref } from '../../validation/web-link';

test.each([
    ['https://eigen.is/help', 'https://eigen.is/help'],
    ['  eigen.is  ', 'https://eigen.is'],
    ['localhost:3000/x', 'https://localhost:3000/x'],
    ['mailto:hi@eigen.is', 'mailto:hi@eigen.is'],
])('%p stores as %p', (address, href) => {
    expect(webLinkHref(address)).toBe(href);
});

test.each(['', '   ', 'dashttps://example.com', 'javascript:alert(1)', 'data:text/html,x', 'https://eig en.is/'])(
    '%p is no link',
    (address) => {
        expect(webLinkHref(address)).toBeNull();
    },
);

test.each([
    [' https://eigen.is ', 'https://eigen.is'],
    ['\teigen.is\n', 'https://eigen.is'],
    [' javascript:alert(1)', null],
])('a stored %p opens as %p', (address, href) => {
    expect(resolveWebLink(address)).toBe(href);
});
