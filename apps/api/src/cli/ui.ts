import { createInterface, type Interface } from 'node:readline';
import { styleText } from 'node:util';

type Validate = (value: string) => string | undefined;

export type Ui = {
    intro(title: string): void;
    ask(question: { message: string; initial: string; validate: Validate; flag: string }): Promise<string>;
    confirm(question: { message: string; initial: boolean; flag: string }): Promise<boolean>;
    password(question: { message: string; flag: string }): Promise<string>;
    note(title: string, lines: string[]): void;
    spinner(label: string): { stop(message: string): void };
    outro(message: string): void;
    fail(message: string, next: string): never;
};

const CANCELLED = 'Setup cancelled. Nothing was written.';
// Foreground and background colors only: bold, dim and the inverse text cursor are not color.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const SGR_COLOR = /\x1b\[(?:3\d|4\d|9[0-7]|10[0-7])m/g;

// The one place that decides between clack and plain lines: clack only on a terminal and without flags,
// so a scripted or piped run never loads it.
export async function createUi(flagsGiven: boolean): Promise<Ui> {
    if (process.stdin.isTTY && process.stdout.isTTY && !flagsGiven) {
        // Bun's styleText, which clack colors through, ignores NO_COLOR.
        if (process.env['NO_COLOR']) {
            const write = process.stdout.write.bind(process.stdout);
            process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) =>
                Reflect.apply(write, undefined, [
                    typeof chunk === 'string' ? chunk.replace(SGR_COLOR, '') : chunk,
                    ...rest,
                ]);
        }
        const clack = await import('@clack/prompts');
        const answered = <T>(value: T | typeof clack.CANCEL_SYMBOL): T => {
            if (clack.isCancel(value)) {
                clack.cancel(CANCELLED);
                process.exit(130);
            }
            return value;
        };
        return {
            intro: (title) => clack.intro(styleText(['bgCyan', 'black'], ` ${title} `)),
            ask: async ({ message, initial, validate }) =>
                answered(
                    await clack.text({ message, initialValue: initial, validate: (value) => validate(value ?? '') }),
                ),
            confirm: async ({ message, initial }) => answered(await clack.confirm({ message, initialValue: initial })),
            password: async ({ message }) => answered(await clack.password({ message })),
            note: (title, lines) => clack.note(lines.join('\n'), title),
            spinner: (label) => {
                const spin = clack.spinner({
                    styleFrame: (frame) => styleText('cyan', frame),
                    onCancel: () => process.exit(130),
                });
                spin.start(label);
                return { stop: (message) => spin.stop(message) };
            },
            outro: (message) => clack.outro(message),
            fail: (message, next) => {
                clack.log.error(message);
                clack.cancel(next);
                process.exit(1);
            },
        };
    }

    // Buffers lines that arrive before a question asks for them: piped stdin delivers every answer up front.
    let reader: Interface | undefined;
    let closed = false;
    const buffered: string[] = [];
    const waiting: ((line: string | null) => void)[] = [];
    const nextLine = (): Promise<string | null> => {
        if (!reader) {
            reader = createInterface({ input: process.stdin });
            reader.on('line', (line) => {
                const resolve = waiting.shift();
                if (resolve) resolve(line);
                else buffered.push(line);
            });
            reader.on('close', () => {
                closed = true;
                for (const resolve of waiting.splice(0)) resolve(null);
            });
        }
        const line = buffered.shift();
        if (line !== undefined) return Promise.resolve(line);
        if (closed) return Promise.resolve(null);
        return new Promise((resolve) => waiting.push(resolve));
    };
    const fail = (message: string, next: string): never => {
        console.error(`\nError: ${message}\n${next}`);
        process.exit(1);
    };
    const read = async (message: string, hint: string, flag: string, echo: boolean): Promise<string> => {
        process.stdout.write(`${message}${hint}: `);
        const line = await nextLine();
        if (line === null) return fail(`No answer for "${message}".`, `Pass ${flag}.`);
        if (!process.stdin.isTTY) process.stdout.write(`${echo ? line : ''}\n`);
        return line;
    };
    return {
        intro: (title) => console.log(title),
        ask: async ({ message, initial, validate, flag }) => {
            // An empty line keeps the default, so an optional answer that has one is cleared with "-".
            const clearable = initial !== '' && !validate('');
            const hint = clearable ? ` [${initial}, - for none]` : initial ? ` [${initial}]` : '';
            const line = (await read(message, hint, flag, true)).trim();
            const answer = clearable && line === '-' ? '' : line || initial;
            const error = validate(answer);
            return error ? fail(error, `Pass ${flag}.`) : answer;
        },
        confirm: async ({ message, initial, flag }) => {
            const answer = (await read(message, initial ? ' [Y/n]' : ' [y/N]', flag, true)).trim().toLowerCase();
            if (!answer) return initial;
            if (answer === 'y' || answer === 'yes') return true;
            if (answer === 'n' || answer === 'no') return false;
            return fail(`Answer y or n to "${message}".`, `Pass ${flag}.`);
        },
        password: ({ message, flag }) =>
            process.stdin.isTTY
                ? fail('A password typed here would show on screen.', `Pass ${flag}.`)
                : read(message, '', flag, false),
        note: (title, lines) => console.log(`\n${title}\n${lines.map((line) => `  ${line}`).join('\n')}`),
        spinner: () => ({ stop: (message) => console.log(message) }),
        outro: (message) => {
            reader?.close();
            console.log(message);
        },
        fail,
    };
}
