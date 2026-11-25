// The two-factor step's `redirect` param is where the page goes once the code is right, by a full page load, so a
// script URL or another site in it becomes the start page. A page of Eigen's own, such as Mail's inbox when Mail sent
// the user here, stays the way back.
import { expect, test } from 'bun:test';
import { isRedirect } from '@tanstack/react-router';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { Route } = await import('../../routes/login-2fa');

const search = (redirect: string) => {
    const { validateSearch } = Route.options;
    if (!validateSearch || !('parse' in validateSearch)) throw new Error('no search schema');
    return validateSearch.parse({ redirect });
};

for (const target of ['javascript:alert(1)', '//evil.example', 'https://evil.example', 'data:text/html,x']) {
    test(`a redirect of ${JSON.stringify(target)} becomes the start page`, () => {
        expect(search(target)).toEqual({ redirect: '/' });
    });
}

test('a page of Eigen, or a path on this origin, stays the way back', () => {
    expect(search('http://localhost:3000/mail/box/inbox')).toEqual({
        redirect: 'http://localhost:3000/mail/box/inbox',
    });
    expect(search('/user')).toEqual({ redirect: '/user' });
});

test('a signed-in visitor goes back to the full URL by a page load', async () => {
    const { beforeLoad } = Route.options;
    if (!beforeLoad) throw new Error('no beforeLoad');
    // Only the two fields this beforeLoad reads, which its full context type would not let a test pass alone.
    const signedIn = {
        context: { auth: { isAuthenticated: true } },
        search: search('http://localhost:3000/mail/box/inbox'),
    };
    const back = await Reflect.apply(beforeLoad, undefined, [signedIn]).catch((error: unknown) => error);
    expect(isRedirect(back) && back.options).toMatchObject({
        href: 'http://localhost:3000/mail/box/inbox',
        reloadDocument: true,
    });
});
