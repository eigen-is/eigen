import { beforeEach, describe, expect, test } from 'bun:test';
import { _resetOtpRateLimitForTests, checkOtpRateLimit } from '../../lib/auth/otp-rate-limit';

describe('OTP rate limiter', () => {
    beforeEach(() => {
        _resetOtpRateLimitForTests();
    });

    test('allows up to MAX_PER_EMAIL requests for one email', () => {
        for (let i = 0; i < 3; i++) {
            expect(() => checkOtpRateLimit('a@x.com', '1.1.1.1')).not.toThrow();
        }
    });

    test('rejects 4th request for the same email', () => {
        for (let i = 0; i < 3; i++) {
            checkOtpRateLimit('a@x.com', `1.1.1.${i}`);
        }
        expect(() => checkOtpRateLimit('a@x.com', '2.2.2.2')).toThrow(/Too many/);
    });

    test('allows different emails from same IP up to MAX_PER_IP', () => {
        for (let i = 0; i < 10; i++) {
            checkOtpRateLimit(`u${i}@x.com`, '1.1.1.1');
        }
        expect(() => checkOtpRateLimit('u11@x.com', '1.1.1.1')).toThrow(/Too many/);
    });

    test('different IPs are tracked independently', () => {
        for (let i = 0; i < 10; i++) {
            checkOtpRateLimit(`u${i}@x.com`, '1.1.1.1');
        }
        expect(() => checkOtpRateLimit('v@x.com', '2.2.2.2')).not.toThrow();
    });

    test('email lookup is case-insensitive', () => {
        for (let i = 0; i < 3; i++) {
            checkOtpRateLimit('Alice@X.com', `1.1.1.${i}`);
        }
        expect(() => checkOtpRateLimit('ALICE@x.COM', '2.2.2.2')).toThrow(/Too many/);
    });
});
