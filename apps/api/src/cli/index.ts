import { type ParseArgsConfig, parseArgs } from 'node:util';
import { BOOTSTRAP_OPTIONS, BOOTSTRAP_USAGE, bootstrap } from './bootstrap';
import { CONFIGURE_OPTIONS, CONFIGURE_USAGE, configure } from './configure';
import { RESET_PASSWORD_OPTIONS, RESET_PASSWORD_USAGE, resetPassword } from './reset-password';
import { setupLink } from './setup-link';
import { RESTORE_OPTIONS, RESTORE_USAGE, restore, SNAPSHOT_OPTIONS, SNAPSHOT_USAGE, snapshot } from './snapshot';
import { status } from './status';

// --help prints the usage; a flag the command does not know, or one argument more than it takes, is refused with it.
function parseFlags<T extends NonNullable<ParseArgsConfig['options']>>(
    args: string[],
    options: T,
    usage: string,
    positionals = 0,
) {
    const refuse = (message: string): never => {
        console.error(`${message}\n\n${usage}`);
        process.exit(2);
    };
    if (args.includes('--help') || args.includes('-h')) {
        console.log(usage);
        process.exit(0);
    }
    const parse = () => parseArgs({ args, options, allowPositionals: true });
    let parsed: ReturnType<typeof parse>;
    try {
        parsed = parse();
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        // The error names the unknown option in its message alone; the tokens name it as typed.
        if ('code' in error && error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
            const { tokens } = parseArgs({ args, options, allowPositionals: true, strict: false, tokens: true });
            for (const token of tokens) {
                if (token.kind === 'option' && !(token.name in options)) refuse(`Unknown argument "${token.rawName}".`);
            }
        }
        return refuse(error.message);
    }
    const extra = parsed.positionals[positionals];
    if (extra !== undefined) refuse(`Unknown argument "${extra}".`);
    return parsed;
}

// status and setup-link are run by the launcher alone, which passes them nothing.
const COMMANDS = new Map<string, (args: string[]) => Promise<void>>([
    ['bootstrap', (args) => bootstrap(parseFlags(args, BOOTSTRAP_OPTIONS, BOOTSTRAP_USAGE).values)],
    ['configure', (args) => configure(parseFlags(args, CONFIGURE_OPTIONS, CONFIGURE_USAGE).values)],
    ['status', status],
    [
        'reset-password',
        (args) => {
            const { values, positionals } = parseFlags(args, RESET_PASSWORD_OPTIONS, RESET_PASSWORD_USAGE, 1);
            return resetPassword(positionals[0], values);
        },
    ],
    ['setup-link', setupLink],
    ['snapshot', (args) => snapshot(parseFlags(args, SNAPSHOT_OPTIONS, SNAPSHOT_USAGE).values)],
    [
        'restore',
        (args) => {
            const { values, positionals } = parseFlags(args, RESTORE_OPTIONS, RESTORE_USAGE, 1);
            return restore(positionals[0], values);
        },
    ],
]);

const USAGE = `Usage: eigen <command> [flags]

Commands:
  bootstrap        Write the launcher, Compose files and a starter .env.production into /out
  configure        Ask the setup questions and write .env.production
  status           Report on the running server (run by ./eigen status)
  reset-password   Set a new password for an account and sign it out everywhere
  setup-link       Print a fresh one-time setup link, or where to sign in once set up
  snapshot         Write data/ and .env.production into snapshots/ (run by ./eigen backup)
  restore          Put data/ and .env.production back from a snapshot (run by ./eigen restore)`;

const [command = '', ...args] = process.argv.slice(2);
const run = COMMANDS.get(command);
if (!run) {
    console.error(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE);
    process.exit(2);
}
await run(args);
