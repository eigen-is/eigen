import { bootstrap } from './bootstrap';
import { configure } from './configure';
import { resetPassword } from './reset-password';
import { setupLink } from './setup-link';
import { restore, snapshot } from './snapshot';
import { status } from './status';

const COMMANDS = new Map([
    ['bootstrap', bootstrap],
    ['configure', configure],
    ['status', status],
    ['reset-password', resetPassword],
    ['setup-link', setupLink],
    ['snapshot', snapshot],
    ['restore', restore],
]);

const USAGE = `Usage: eigen <command> [flags]

Commands:
  bootstrap        Write the launcher, Compose files and a starter .env.production into /out
  configure        Ask the setup questions and write .env.production
  status           Report on the running server (run by ./eigen status)
  reset-password   Set a new password for an account and sign it out everywhere
  setup-link       Print a fresh one-time setup link, or where to sign in once set up
  snapshot         Write data/ and .env.production into backups/ (run by ./eigen backup)
  restore          Put data/ and .env.production back from a snapshot (run by ./eigen restore)`;

const [command = '', ...args] = process.argv.slice(2);
const run = COMMANDS.get(command);
if (!run) {
    console.error(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE);
    process.exit(2);
}
await run(args);
