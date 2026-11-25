// The two-factor step's `redirect` param is where the page goes once the code is right, by a full page load, so a
// script URL or another site in it becomes the start page. A page of Eigen's own stays the way back.
import { expect, test } from 'bun:test';
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

test('a path on this origin stays the way back', () => {
    expect(search('/box/inbox')).toEqual({ redirect: '/box/inbox' });
});
