// Signs demo personas in for the capture tool and opens a browser context as one of them, for a scene to film. A
// persona, or the seeded admin who runs the server, signs in through the API's own email sign-in, from Node, because
// the API trusts no capture port as an origin. The CLI signs each persona in once per run, since the API allows only
// a few sign-ins a minute. The session token then goes into each context with the scene's viewport at double density
// and its theme set before any page loads, and a video's or a pointing still's context gets the visible cursor.

import type { Browser, BrowserContext } from 'playwright-core';
import { THEME_COPY_KEY } from '../../../packages/lib/src/constants/theme';
import { APP_PORTS } from '../../../vite.shared.config';
import { ADMIN_LOCALPART, DEMO_MAIL_DOMAIN, emailFor, personaByKey } from '../../api/src/scripts/demo/content';
import { CURSOR_SCRIPT } from './lib/cursor';
import type { Scene, Stack } from './lib/scene';

const SIGN_IN_ORIGIN = `http://localhost:${APP_PORTS.index}`;
const SESSION_COOKIE = 'better-auth.session_token';

export async function signIn(stack: Stack, key: string): Promise<string> {
    const admin = key === ADMIN_LOCALPART;
    const email = emailFor(admin ? ADMIN_LOCALPART : personaByKey(key).key, DEMO_MAIL_DOMAIN);
    const res = await fetch(`${stack.apiUrl}/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: SIGN_IN_ORIGIN },
        body: JSON.stringify({ email, password: admin ? stack.adminPassword : stack.personaPassword }),
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
    { kind, theme, viewport, pointer }: Pick<Scene, 'kind' | 'theme' | 'viewport' | 'pointer'>,
): Promise<BrowserContext> {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addCookies([{ name: SESSION_COOKIE, value: sessionToken, domain: 'localhost', path: '/' }]);
    await context.addInitScript(`localStorage.setItem(${JSON.stringify(THEME_COPY_KEY)}, ${JSON.stringify(theme)});`);
    if (kind === 'video' || pointer) await context.addInitScript(CURSOR_SCRIPT);
    return context;
}
