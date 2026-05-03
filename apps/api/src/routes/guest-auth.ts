import { Elysia, t } from 'elysia';
import { requestOtp, verifyOtpAndSignIn } from '../lib/auth/guest-auth';

export const guestAuthRouter = new Elysia({ name: 'guest-auth' })
    .post(
        '/guest-auth/request-otp',
        async ({ body, request, server }) => {
            const ip = server?.requestIP(request)?.address ?? 'unknown';
            await requestOtp(body.email.toLowerCase().trim(), ip);
            return { success: true };
        },
        { body: t.Object({ email: t.String() }) },
    )
    .post(
        '/guest-auth/verify-otp',
        async ({ body }) => {
            return verifyOtpAndSignIn(body.email.toLowerCase().trim(), body.otp);
        },
        { body: t.Object({ email: t.String(), otp: t.String() }) },
    );
