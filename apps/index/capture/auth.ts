// Signs demo personas in for the capture tool and opens a browser context as one of them, for a scene to film. A
// persona, or the seeded admin who runs the server, signs in through the API's own email sign-in, from Node, because
// the API trusts no capture port as an origin. The CLI signs each persona in once per run, since the API allows only
// a few sign-ins a minute. Before each context opens, the persona's own theme setting is saved as the scene's, since a
// signed-in user's setting outranks the browser's copy. The session token then goes into the context with the scene's
// viewport at double density and that copy set, so the first frame is drawn in the theme too, and a video's or a
// pointing still's context gets the visible cursor.

import type { Browser, BrowserContext } from 'playwright-core';
import { THEME_COPY_KEY } from '../../../packages/lib/src/constants/theme';
import { APP_PORTS } from '../../../vite.shared.config';
import { ADMIN_LOCALPART, DEMO_MAIL_DOMAIN, emailFor, personaByKey } from '../../api/src/scripts/demo/content';
import { CURSOR_SCRIPT } from './lib/cursor';
import type { Scene, Stack } from './lib/scene';

const SIGN_IN_ORIGIN = `http://localhost:${APP_PORTS.index}`;
const SESSION_COOKIE = 'better-auth.session_token';

export type Session = { token: string; userId: string };

export async function signIn(stack: Stack, key: string): Promise<Session> {
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
    const userId = (await res.json())?.user?.id;
    if (typeof userId !== 'string') throw new Error(`Signing in ${email} returned no user id`);
    return { token: cookie.slice(SESSION_COOKIE.length + 1), userId };
}

export async function personaContext(
    browser: Browser,
    stack: Stack,
    { token, userId }: Session,
    { kind, theme, viewport, pointer }: Pick<Scene, 'kind' | 'theme' | 'viewport' | 'pointer'>,
): Promise<BrowserContext> {
    const res = await fetch(`${stack.apiUrl}/space/${userId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: SIGN_IN_ORIGIN, Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ theme }),
    });
    if (!res.ok) throw new Error(`Saving the ${theme} theme failed (${res.status}): ${await res.text()}`);
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addCookies([{ name: SESSION_COOKIE, value: token, domain: 'localhost', path: '/' }]);
    await context.addInitScript(`localStorage.setItem(${JSON.stringify(THEME_COPY_KEY)}, ${JSON.stringify(theme)});`);
    if (kind === 'video' || pointer) await context.addInitScript(CURSOR_SCRIPT);
    return context;
}
