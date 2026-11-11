import { describe, expect, test } from 'bun:test';
import {
    checkOtpRateLimit,
    countOtpGuess,
    MAX_OTP_GUESSES,
    MAX_OTP_REQUESTS_PER_EMAIL,
    MAX_OTP_REQUESTS_PER_IP,
    refundOtpRequests,
    resetOtpGuesses,
} from '../../lib/auth/otp-rate-limit';

// The limiter's state lasts as long as the process, so every test counts on emails and IPs of its own.
describe('OTP rate limiter', () => {
    test('allows up to the per-email limit for one email', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            expect(() => checkOtpRateLimit('a@t1.example', '192.0.2.1')).not.toThrow();
        }
    });

    test('rejects the request past the per-email limit', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            checkOtpRateLimit('a@t2.example', `198.51.2.${i}`);
        }
        expect(() => checkOtpRateLimit('a@t2.example', '203.0.113.2')).toThrow(/Too many/);
    });

    test('allows different emails from the same IP up to the per-IP limit', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_IP; i++) {
            checkOtpRateLimit(`u${i}@t3.example`, '192.0.2.3');
        }
        expect(() => checkOtpRateLimit('one-more@t3.example', '192.0.2.3')).toThrow(/Too many/);
    });

    test('different IPs are tracked independently', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_IP; i++) {
            checkOtpRateLimit(`u${i}@t4.example`, '192.0.2.4');
        }
        expect(() => checkOtpRateLimit('v@t4.example', '203.0.113.4')).not.toThrow();
    });

    test('email lookup is case-insensitive', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            checkOtpRateLimit('Alice@T5.example', `198.51.5.${i}`);
        }
        expect(() => checkOtpRateLimit('ALICE@t5.EXAMPLE', '203.0.113.5')).toThrow(/Too many/);
    });

    test('a refund hands back the email and its share of the IP', () => {
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            checkOtpRateLimit('a@t6.example', '192.0.2.6');
        }
        for (let i = 0; i < MAX_OTP_REQUESTS_PER_IP - MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            checkOtpRateLimit(`u${i}@t6.example`, '192.0.2.6');
        }
        expect(() => checkOtpRateLimit('late@t6.example', '192.0.2.6')).toThrow(/Too many/);

        refundOtpRequests('A@t6.example', '192.0.2.6');

        for (let i = 0; i < MAX_OTP_REQUESTS_PER_EMAIL; i++) {
            expect(() => checkOtpRateLimit('a@t6.example', '192.0.2.6')).not.toThrow();
        }
        expect(() => checkOtpRateLimit('late@t6.example', '192.0.2.6')).toThrow(/Too many/);
    });

    describe('guesses per code', () => {
        const expiresAt = new Date(Date.now() + 60_000);

        test('allows the full set of guesses, then refuses', () => {
            for (let i = 0; i < MAX_OTP_GUESSES; i++) {
                expect(countOtpGuess('a@t7.example', expiresAt)).toBe(true);
            }
            expect(countOtpGuess('a@t7.example', expiresAt)).toBe(false);
        });

        test('emails are counted independently', () => {
            for (let i = 0; i < MAX_OTP_GUESSES; i++) countOtpGuess('a@t8.example', expiresAt);
            expect(countOtpGuess('b@t8.example', expiresAt)).toBe(true);
        });

        test('a reset gives a new code its own guesses', () => {
            for (let i = 0; i <= MAX_OTP_GUESSES; i++) countOtpGuess('a@t9.example', expiresAt);
            resetOtpGuesses('a@t9.example');
            expect(countOtpGuess('a@t9.example', expiresAt)).toBe(true);
        });

        test('a count left behind by an expired code does not carry over', () => {
            const past = new Date(Date.now() - 1);
            for (let i = 0; i <= MAX_OTP_GUESSES; i++) countOtpGuess('a@t10.example', past);
            expect(countOtpGuess('a@t10.example', expiresAt)).toBe(true);
        });
    });
});
