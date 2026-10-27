// The public sign-in routes for guests: ask for a one-time code by email, and send the code back to get a session.
// The checks and the rate limits are in the auth code, so these routes only pass the request on.

import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { clientIpKey } from '../lib/auth/access';
import { requestOtp, verifyOtpAndSignIn } from '../lib/auth/guest-auth';

export const guestAuthRouter = new Elysia({ name: 'guest-auth' })
    .post(
        '/guest-auth/request-otp',
        async ({ body, request, server }) => {
            await requestOtp(body.email.toLowerCase().trim(), clientIpKey(request, server));
            return { success: true };
        },
        { body: t.Object({ email: t.String({ maxLength: MAX_EMAIL_LENGTH }) }) },
    )
    .post(
        '/guest-auth/verify-otp',
        async ({ body, request, server }) => {
            return verifyOtpAndSignIn(body.email.toLowerCase().trim(), body.otp, clientIpKey(request, server));
        },
        { body: t.Object({ email: t.String({ maxLength: MAX_EMAIL_LENGTH }), otp: t.String() }) },
    );
