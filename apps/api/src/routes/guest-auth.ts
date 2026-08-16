import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { requestOtp, verifyOtpAndSignIn } from '../lib/auth/guest-auth';
import { clientIpKey } from '../lib/core/access';

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
        async ({ body }) => {
            return verifyOtpAndSignIn(body.email.toLowerCase().trim(), body.otp);
        },
        { body: t.Object({ email: t.String({ maxLength: MAX_EMAIL_LENGTH }), otp: t.String() }) },
    );
