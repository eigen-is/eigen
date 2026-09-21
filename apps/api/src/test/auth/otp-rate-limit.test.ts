import { beforeEach, describe, expect, test } from 'bun:test';
import {
    _resetOtpRateLimitForTests,
    checkOtpRateLimit,
    countOtpGuess,
    MAX_OTP_GUESSES,
    MAX_OTP_REQUESTS_PER_EMAIL,
    MAX_OTP_REQUESTS_PER_IP,
    refundOtpRequests,
    resetOtpGuesses,
} from '../../lib/auth/otp-rate-limit';

describe('OTP rate limiter', () => {
    beforeEach(() => {
        _resetOtpRateLimitForTests();
    });

    test('allows up to the per-email limit for one email', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            expect(() => checkOtpRateLimit('a@x.com', '1.1.1.1')).not.toThrow();
        }
    });

    test('rejects the request past the per-email limit', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            checkOtpRateLimit('a@x.com', `1.1.1.${i}`);
        }
        expect(() => checkOtpRateLimit('a@x.com', '2.2.2.2')).toThrow(/Too many/);
    });

    test('allows different emails from the same IP up to the per-IP limit', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_IP; i++) {
            checkOtpRateLimit(`u${i}@x.com`, '1.1.1.1');
        }
        expect(() => checkOtpRateLimit('one-more@x.com', '1.1.1.1')).toThrow(/Too many/);
    });

    test('different IPs are tracked independently', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_IP; i++) {
            checkOtpRateLimit(`u${i}@x.com`, '1.1.1.1');
        }
        expect(() => checkOtpRateLimit('v@x.com', '2.2.2.2')).not.toThrow();
    });

    test('email lookup is case-insensitive', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            checkOtpRateLimit('Alice@X.com', `1.1.1.${i}`);
        }
        expect(() => checkOtpRateLimit('ALICE@x.COM', '2.2.2.2')).toThrow(/Too many/);
    });

    test('a refund hands back the email and its share of the IP', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            checkOtpRateLimit('a@x.com', '1.1.1.1');
        }
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_IP - MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            checkOtpRateLimit(`u${i}@x.com`, '1.1.1.1');
        }
        expect(() => checkOtpRateLimit('late@x.com', '1.1.1.1')).toThrow(/Too many/);

        refundOtpRequests('A@x.com', '1.1.1.1');

        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            expect(() => checkOtpRateLimit('a@x.com', '1.1.1.1')).not.toThrow();
        }
        expect(() => checkOtpRateLimit('late@x.com', '1.1.1.1')).toThrow(/Too many/);
    });

    describe('guesses per code', () => {
        const expiresAt = new Date(Date.now() + 60_000);

        test('allows the full set of guesses, then refuses', () => {
            for (let i = 0; i < MAX_OTP_GUESSES; i++) {
                expect(countOtpGuess('a@x.com', expiresAt)).toBe(true);
            }
            expect(countOtpGuess('a@x.com', expiresAt)).toBe(false);
        });

        test('emails are counted independently', () => {
            for (let i = 0; i < MAX_OTP_GUESSES; i++) countOtpGuess('a@x.com', expiresAt);
            expect(countOtpGuess('b@x.com', expiresAt)).toBe(true);
        });

        test('a reset gives a new code its own guesses', () => {
            for (let i = 0; i <= MAX_OTP_GUESSES; i++) countOtpGuess('a@x.com', expiresAt);
            resetOtpGuesses('a@x.com');
            expect(countOtpGuess('a@x.com', expiresAt)).toBe(true);
        });

        test('a count left behind by an expired code does not carry over', () => {
            const past = new Date(Date.now() - 1);
            for (let i = 0; i <= MAX_OTP_GUESSES; i++) countOtpGuess('a@x.com', past);
            expect(countOtpGuess('a@x.com', expiresAt)).toBe(true);
        });
    });
});
