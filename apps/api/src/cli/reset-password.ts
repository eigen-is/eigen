import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { callControl } from './control-socket';
import { createUi } from './ui';

// better-auth's default minimum; the API checks its own configured one again.
const MIN_PASSWORD_LENGTH = 8;
const USAGE = `Usage: reset-password <email> [--generate]

Sets a new password for the account with this address, signs it out everywhere and revokes
its app passwords.
It asks for the password, or reads one line from stdin when that is not a terminal.

  --generate   Make up a strong password and print it once`;

export async function resetPassword(args: string[]): Promise<void> {
    let parsed: { values: { generate?: boolean; help?: boolean }; positionals: string[] };
    try {
        parsed = parseArgs({
            args,
            options: { generate: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
            allowPositionals: true,
        });
    } catch (error) {
        console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
        process.exit(2);
    }
    const { values: flags, positionals } = parsed;
    if (flags.help) {
        console.log(USAGE);
        return;
    }
    const [email, ...extra] = positionals;
    if (!email || extra.length) {
        console.error(USAGE);
        process.exit(2);
    }

    const ui = await createUi(flags.generate === true);
    ui.intro('Reset a password');
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
            res.status === 404 ? 'Check the address and run the command again.' : 'Nothing was changed.',
        );
    }
    const changed: { email: string } = await res.json();
    if (flags.generate) console.log(`New password: ${password}`);
    ui.outro(`Password changed for ${changed.email}. Its sessions and app passwords are revoked.`);
}
