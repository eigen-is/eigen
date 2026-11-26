// The page a sign-in goes on to comes from a URL anyone can write, so only a path on this origin or a page of one of
// Eigen's apps passes. Anything else, a script URL or another site, becomes the start page. The apps run as in dev,
// each on an origin of its own.
import { afterAll, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';

installHappyDom();

const previous = process.env.VITE_APP_MAIL_URL;
process.env.VITE_APP_MAIL_URL = 'http://localhost:3001/mail';
afterAll(() => {
    if (previous === undefined) delete process.env.VITE_APP_MAIL_URL;
    else process.env.VITE_APP_MAIL_URL = previous;
});

// The app URLs are read as the module loads, so the query makes bun load it anew with Mail's URL set.
const freshApi = '../../core/api?mail-url';
const { safeRedirect }: typeof import('../../core/api') = await import(freshApi);

for (const target of [
    'javascript:alert(document.cookie)',
    ' javascript:alert(1)',
    '//evil.example/path',
    '/\\evil.example',
    '/\t/evil.example',
    'https://evil.example',
    'https://localhost:3001.evil.example/mail',
    'data:text/html,<script>alert(1)</script>',
    'box/inbox',
]) {
    test(`refuses ${JSON.stringify(target)}`, () => {
        expect(safeRedirect(target)).toBe('/');
    });
}

test('a path on this origin passes as it is', () => {
    expect(safeRedirect('/fs/u1/default/root?view=grid#top')).toBe('/fs/u1/default/root?view=grid#top');
});

test("another Eigen app's page passes, so a sign-in from Mail lands back in Mail", () => {
    expect(safeRedirect('http://localhost:3001/mail/box/inbox')).toBe('http://localhost:3001/mail/box/inbox');
});
