import cors from '@elysiajs/cors';
import { serverTiming } from '@elysiajs/server-timing';
import swagger from '@elysiajs/swagger';
import Elysia from 'elysia';
import { rateLimit } from 'elysia-rate-limit';
import { trustedOrigins } from './lib/auth/auth';
import { caldavRouter } from './lib/caldav/caldav-router';
import { isProduction } from './lib/config/env';
import { clientIpKey } from './lib/core/access';
import { ApiError } from './lib/core/errors';
import { webdavRouter } from './lib/webdav/webdav-router';
import { betterAuth } from './routes/auth';
import { calendarRouter } from './routes/calendar';
import { chatRouter } from './routes/chat';
import { collabRouter } from './routes/collab';
import { contactsRouter } from './routes/contacts';
import { demoRouter } from './routes/demo';
import { driveRouter } from './routes/drive';
import { editorRouter } from './routes/editor';
import { guestAuthRouter } from './routes/guest-auth';
import { homeRouter } from './routes/home';
import { internalRouter } from './routes/internal';
import { mailRouter } from './routes/mail';
import { notificationRouter } from './routes/notification';
import { publicRouter } from './routes/public';
import { searchRouter } from './routes/search';
import { settingsRouter } from './routes/settings';
import { setupRouter } from './routes/setup';
import { spaceRouter } from './routes/space';
import { sseRouter } from './routes/sse';
import { teamRouter } from './routes/team';
import { waitlistRouter } from './routes/waitlist';

const SLOW_REQUEST_MS = 200;

// CalDAV adds class-3, calendar-access, REPORT, MKCALENDAR on top of WebDAV.
// Advertising REPORT/MKCALENDAR on /webdav would lie about supported verbs.
const CALDAV_CAPABILITY_HEADERS = {
    DAV: '1, 2, 3, calendar-access',
    Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK, REPORT, MKCALENDAR',
};
const WEBDAV_CAPABILITY_HEADERS = {
    DAV: '1, 2',
    Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK',
};

export const app = new Elysia({
    // WebSocket server options MUST live on the root instance: Elysia builds
    // Bun.serve's `websocket` handler from `app.config.websocket` (+ listen
    // options) only — `websocket` config set on a `.use()`d plugin (e.g.
    // collabRouter) is silently ignored. perMessageDeflate compresses the large
    // Yjs sync frames (the ~48MB sheets snapshot) on the wire.
    websocket: {
        perMessageDeflate: true,
        // Bun's 16MB default is measured on the decoded frame — below the ~48MB
        // worst-case sheets snapshot sync, which would close the socket with code 1009.
        maxPayloadLength: 128 * 1024 * 1024,
    },
})
    // swagger() publishes the full OpenAPI schema + try-it-out UI, serverTiming() leaks
    // phase timings in response headers — both are dev-only surface.
    .use((app) => (isProduction() ? app : app.use(serverTiming()).use(swagger())))
    // Handle CalDAV/WebDAV OPTIONS before CORS intercepts them — DAV clients need capability headers
    .onRequest(({ request }) => {
        if (request.method !== 'OPTIONS') return;
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith('/webdav')) {
            return new Response(null, { status: 204, headers: WEBDAV_CAPABILITY_HEADERS });
        }
        if (pathname.startsWith('/dav')) {
            return new Response(null, { status: 204, headers: CALDAV_CAPABILITY_HEADERS });
        }
    })
    .use(
        cors({
            origin: trustedOrigins,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            credentials: true,
            allowedHeaders: ['Content-Type', 'Authorization'],
        }),
    )
    .use(
        rateLimit({
            duration: 60_000,
            max: 1000,
            generator: (request, server) => clientIpKey(request, server),
            skip: (request, key) => {
                if (key === 'unknown') return true; // No server (tests / app.handle())
                const path = new URL(request.url).pathname;
                // /p/avatar is public, cached, and fetched in bulk (member lists) — exempt it
                return path === '/health' || path.endsWith('/events') || path.startsWith('/p/avatar/');
            },
        }),
    )
    .state('requestStart', 0)
    .onBeforeHandle(({ store }) => {
        store.requestStart = Bun.nanoseconds();
    })
    .onAfterResponse(({ store, request, set }) => {
        const ms = (Bun.nanoseconds() - store.requestStart) / 1_000_000;
        if (ms > SLOW_REQUEST_MS) {
            console.warn(
                `[slow] ${request.method} ${new URL(request.url).pathname} ${ms.toFixed(1)}ms → ${set.status}`,
            );
        }
    })
    .use(betterAuth)
    .use(setupRouter)
    .use(guestAuthRouter)

    .use(mailRouter)
    .use(contactsRouter)
    .use(calendarRouter)
    .use(teamRouter)
    .use(settingsRouter)
    .use(waitlistRouter)
    .use(spaceRouter)
    .use(publicRouter)
    .use(demoRouter)
    .use(driveRouter)
    .use(homeRouter)
    .use(collabRouter)
    .use(chatRouter)
    .use(editorRouter)
    .use(notificationRouter)
    .use(searchRouter)
    .use(sseRouter)
    .use(internalRouter)
    .use(caldavRouter)
    .use(webdavRouter)

    .onError(({ error, set, code, request }) => {
        if (code === 'VALIDATION') return;
        const err = error as Error;
        if (err instanceof ApiError) {
            set.status = err.status;
            if (err.status === 401) {
                const pathname = new URL(request.url).pathname;
                if (pathname.startsWith('/dav')) {
                    set.headers['WWW-Authenticate'] = 'Basic realm="Eigen CalDAV"';
                } else if (pathname.startsWith('/webdav')) {
                    set.headers['WWW-Authenticate'] = 'Basic realm="Eigen Drive"';
                }
            }
            return err.message;
        }
        console.error('API Error:', err);
        set.status = 500;
        return 'Internal server error';
    })
    .get('/', () => 'eigen|api>')
    .get('/health', () => 'OK');

export type App = typeof app;
