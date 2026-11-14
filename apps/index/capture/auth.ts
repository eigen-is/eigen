// Signs demo personas in for the capture tool and opens a browser context as one of them, for a scene to film. A
// persona signs in through the API's own email sign-in, from Node, because the API trusts no capture port as an
// origin. The CLI signs each persona in once per run, since the API allows only a few sign-ins a minute. The session
// token then goes into each context with the scene's viewport at double density, its theme set before any page loads,
// and the visible cursor.

import type { Browser, BrowserContext } from 'playwright-core';
import { THEME_COPY_KEY } from '../../../packages/lib/src/constants/theme';
import { APP_PORTS } from '../../../vite.shared.config';
import { DEMO_MAIL_DOMAIN, emailFor, personaByKey } from '../../api/src/scripts/demo/content';
import { CURSOR_SCRIPT } from './lib/cursor';
import type { Scene, Stack } from './lib/scene';

const SIGN_IN_ORIGIN = `http://localhost:${APP_PORTS.index}`;
const SESSION_COOKIE = 'better-auth.session_token';

export async function signIn(stack: Stack, personaKey: string): Promise<string> {
    const email = emailFor(personaByKey(personaKey).key, DEMO_MAIL_DOMAIN);
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
    return cookie.slice(SESSION_COOKIE.length + 1);
}

export async function personaContext(
    browser: Browser,
    sessionToken: string,
    { theme, viewport }: Pick<Scene, 'theme' | 'viewport'>,
): Promise<BrowserContext> {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addCookies([{ name: SESSION_COOKIE, value: sessionToken, domain: 'localhost', path: '/' }]);
    await context.addInitScript(`localStorage.setItem(${JSON.stringify(THEME_COPY_KEY)}, ${JSON.stringify(theme)});`);
    await context.addInitScript(CURSOR_SCRIPT);
    return context;
}
