import { randomBytes } from 'node:crypto';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import type { ResetPasswordResult } from '../lib/user/reset-password';
import { callControl } from './control-socket';
import { createUi } from './ui';

export const RESET_PASSWORD_OPTIONS = { generate: { type: 'boolean' } } as const;
export const RESET_PASSWORD_USAGE = `Usage: ./eigen reset-password <email> [--generate]

Sets a new password for the account with this address and signs it out everywhere. Its app
passwords, for mail, calendar and file apps, stop working too.
It asks for the password, or reads one line from stdin when that is not a terminal.

  --generate   Make up a strong password and print it once`;

export async function resetPassword(email: string | undefined, flags: { generate?: boolean }): Promise<void> {
    const ui = await createUi(flags.generate === true);
    if (!email) return ui.fail('Name the account.', 'Run ./eigen reset-password <email>.');
    let password = randomBytes(12).toString('base64url');
    if (!flags.generate) {
        password = await ui.password({
            message: `New password for ${email}`,
            validate: (value) =>
                value.length < MIN_PASSWORD_LENGTH
                    ? `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`
                    : undefined,
            flag: '--generate',
        });
        // Piped input is typed by a script, not a person: nothing to confirm.
        if (process.stdin.isTTY) {
            await ui.password({
                message: 'Again, to confirm',
                validate: (value) => (value === password ? undefined : 'The two passwords differ.'),
                flag: '--generate',
            });
        }
    }

    const res = await callControl('/reset-password', ui.fail, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
        ui.fail(
            await res.text(),
            res.status === 404
                ? 'Check the address, then run ./eigen reset-password again.'
                : 'Run ./eigen reset-password again with another address or password.',
        );
    }
    const changed: ResetPasswordResult = await res.json();
    if (flags.generate) console.log(`New password: ${password}`);
    ui.outro(`Password changed for ${changed.email}. Signed out everywhere.`);
}
