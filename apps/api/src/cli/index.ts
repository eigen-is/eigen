import { bootstrap } from './bootstrap';
import { configure } from './configure';

const COMMANDS = new Map([
    ['bootstrap', bootstrap],
    ['configure', configure],
]);

const USAGE = `Usage: eigen <command> [flags]

Commands:
  bootstrap   Write the launcher, Compose files and a starter .env.production into /out
  configure   Ask the setup questions and write .env.production`;

const [command = '', ...args] = process.argv.slice(2);
const run = COMMANDS.get(command);
if (!run) {
    console.error(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE);
    process.exit(2);
}
await run(args);
