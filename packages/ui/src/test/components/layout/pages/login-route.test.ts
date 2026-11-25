// The /login route every app builds: its `redirect` param is the page a sign-in goes on to, so a script URL or another
// site in it becomes the start page, and a visitor who already has a session lands on a page of Eigen's own.
import { expect, test } from 'bun:test';
import { isRedirect } from '@tanstack/react-router';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const { createLoginRouteOptions } = await import('../../../../components/layout/pages/login-route');

const options = createLoginRouteOptions('/box/inbox');
const search = (redirect?: string) => options.validateSearch.parse({ redirect });

const signedInRedirect = (redirect?: string) =>
    options
        .beforeLoad({ context: { auth: { isAuthenticated: true } }, search: search(redirect) })
        .catch((error: unknown) => error);

for (const target of ['javascript:alert(1)', '//evil.example', 'https://evil.example', '/\\evil.example']) {
    test(`a redirect of ${JSON.stringify(target)} becomes the start page`, () => {
        expect(search(target).redirect).toBe('/');
    });
}

test('a path on this origin stays the way back', () => {
    expect(search('/box/sent?page=2').redirect).toBe('/box/sent?page=2');
});

test('a signed-in visitor goes on to the way back, or with none to the app start page', async () => {
    const back = await signedInRedirect('/box/sent');
    expect(isRedirect(back) && back.options.to).toBe('/box/sent');
    const start = await signedInRedirect();
    expect(isRedirect(start) && start.options.to).toBe('/box/inbox');
    const refused = await signedInRedirect('https://evil.example');
    expect(isRedirect(refused) && refused.options.to).toBe('/');
});
