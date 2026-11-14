// Opens a browser context signed in as one demo persona, for a capture scene to film. The persona signs in through the
// API's own email sign-in, from Node, because the API trusts no capture port as an origin; the session cookie then
// goes into a context with the scene's viewport at double density, its theme set before any page loads, and the
// visible cursor.

import type { Browser, BrowserContext } from 'playwright-core';
import { personaByKey } from '../../apps/api/src/scripts/demo/content';
import { THEME_COPY_KEY } from '../../packages/lib/src/constants/theme';
import { CURSOR_SCRIPT } from './lib/cursor';
import type { Scene, Stack } from './lib/scene';
import { MAIL_DOMAIN } from './stack';

// A dev origin the API trusts for a sign-in.
const SIGN_IN_ORIGIN = 'http://localhost:3014';
const SESSION_COOKIE = 'better-auth.session_token';

export async function personaContext(
    browser: Browser,
    stack: Stack,
    personaKey: string,
    { theme, viewport }: Pick<Scene, 'theme' | 'viewport'>,
): Promise<BrowserContext> {
    const email = `${personaByKey(personaKey).key}@${MAIL_DOMAIN}`;
    const res = await fetch(`${stack.apiUrl}/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: SIGN_IN_ORIGIN },
        body: JSON.stringify({ email, password: stack.personaPassword }),
    });
    if (!res.ok) throw new Error(`Signing in ${email} failed (${res.status}): ${await res.text()}`);
    const cookie = res.headers
        .getSetCookie()
        .map((header) => header.split(';')[0])
        .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
    if (!cookie) throw new Error(`Signing in ${email} set no ${SESSION_COOKIE}`);

    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addCookies([
        { name: SESSION_COOKIE, value: cookie.slice(SESSION_COOKIE.length + 1), domain: 'localhost', path: '/' },
    ]);
    await context.addInitScript(`localStorage.setItem(${JSON.stringify(THEME_COPY_KEY)}, ${JSON.stringify(theme)});`);
    await context.addInitScript(CURSOR_SCRIPT);
    return context;
}
