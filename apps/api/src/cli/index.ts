import { configure } from './configure';

const COMMANDS = new Map([['configure', configure]]);

const USAGE = `Usage: eigen <command> [flags]

Commands:
  configure   Ask the setup questions and write .env.production`;

const [command = '', ...args] = process.argv.slice(2);
const run = COMMANDS.get(command);
if (!run) {
    console.error(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE);
    process.exit(2);
}
await run(args);
