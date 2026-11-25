// A password sign-in that needs a second step goes to Space's two-factor page by a page load, since Space may be on
// another origin. The page that sent the user to sign in rides along as a full URL, checked first, so after the code
// they land back in the app they came from.
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';

const window = installHappyDom();
// better-auth keeps the fetch it finds as the client is made, so the stub goes in first, and the query makes bun load
// the module anew even where another test file made the client already.
const answer = spyOn(globalThis, 'fetch');
const freshClient = '../../../../core/auth/hooks/use-auth-client?two-factor';
const { authClient }: typeof import('../../../../core/auth/hooks/use-auth-client') = await import(freshClient);

afterAll(() => mock.restore());

// Signs in on the login page at `url`, answered by better-auth's "a second step is needed", and returns where the
// page went.
async function signInAt(url: string) {
    window.happyDOM.setURL(url);
    answer.mockResolvedValue(Response.json({ twoFactorRedirect: true }));
    const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
    await authClient.signIn.email({ email: 'me@test.eigen.is', password: 'secret' });
    const [target] = assign.mock.calls.map(([href]) => new URL(href, url));
    assign.mockRestore();
    return target;
}

test("Mail hands Space's two-factor step the full Mail URL as the way back", async () => {
    const inbox = 'http://localhost:3000/mail/box/inbox';
    const target = await signInAt(`http://localhost:3000/mail/login?redirect=${encodeURIComponent(inbox)}`);
    expect(target?.pathname.endsWith('/login-2fa')).toBe(true);
    expect(target?.searchParams.get('redirect')).toBe(inbox);
});

test('a way back that is no page of Eigen becomes the start page', async () => {
    const target = await signInAt('http://localhost:3000/mail/login?redirect=https%3A%2F%2Fevil.example');
    expect(target?.searchParams.get('redirect')).toBe('http://localhost:3000/');
});
