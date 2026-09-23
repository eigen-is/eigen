import { createInterface, type Interface } from 'node:readline';
import { styleText } from 'node:util';

type Validate = (value: string) => string | undefined;

// `help` says what a question is for, under it; interactive only, so scripts and logs stay one line per question.
type Question = { message: string; help?: string; flag: string };
type Choice = { value: boolean; label: string; hint: string };

export type Ui = {
    intro(title: string): void;
    explain(text: string): void;
    ask(question: Question & { initial: string; placeholder?: string; validate: Validate }): Promise<string>;
    confirm(question: Question & { initial: boolean }): Promise<boolean>;
    select(question: Question & { options: Choice[]; initial: boolean }): Promise<boolean>;
    password(question: Question & { validate: Validate }): Promise<string>;
    note(title: string, lines: string[]): void;
    outro(message: string): void;
    fail(message: string, next: string): never;
};

const CANCELLED = 'Cancelled. Nothing was changed.';
// Foreground and background colors only: bold, dim and the inverse text cursor are not color.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const SGR_COLOR = /\x1b\[(?:3\d|4\d|9[0-7]|10[0-7])m/g;

// Word-wraps each paragraph, since clack's log keeps its guide bar only on the lines it is given.
function wrap(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(' ')) {
            if (line && line.length + word.length >= width) {
                lines.push(line);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        }
        lines.push(line);
    }
    return lines;
}

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
        const dimLines = (text: string, width = Math.min(process.stdout.columns, 80) - 4) =>
            wrap(text, width).map((line) => styleText('dim', line));
        // Help goes under the question: text prints its message as is, confirm and select wrap it and add the bar.
        const textMessage = ({ message, help }: Question) =>
            [message, ...(help ? dimLines(help).map((line) => `${styleText('gray', clack.S_BAR)}  ${line}`) : [])].join(
                '\n',
            );
        const confirmMessage = ({ message, help }: Question) =>
            [message, ...(help ? dimLines(help, Number.POSITIVE_INFINITY) : [])].join('\n');
        return {
            intro: (title) => clack.intro(styleText(['bgCyan', 'black'], ` ${title} `)),
            explain: (text) => clack.log.message(dimLines(text)),
            ask: async ({ initial, placeholder, validate, ...question }) =>
                answered(
                    await clack.text({
                        message: textMessage(question),
                        initialValue: initial,
                        placeholder,
                        validate: (value) => validate(value ?? ''),
                    }),
                ),
            confirm: async ({ initial, ...question }) =>
                answered(await clack.confirm({ message: confirmMessage(question), initialValue: initial })),
            select: async ({ options, initial, ...question }) =>
                answered(await clack.select({ message: confirmMessage(question), options, initialValue: initial })),
            password: async ({ validate, ...question }) =>
                answered(
                    await clack.password({
                        message: textMessage(question),
                        validate: (value) => validate(value ?? ''),
                    }),
                ),
            note: (title, lines) => clack.note(lines.join('\n'), title),
            outro: (message) => clack.outro(message),
            fail: (message, next) => {
                clack.log.error(message);
                clack.cancel(next);
                process.exit(1);
            },
        };
    }

    // Created on the first question, so a run that asks nothing never holds stdin open.
    let reader: Interface | undefined;
    let stdinLines: AsyncIterator<string> | undefined;
    const fail = (message: string, next: string): never => {
        console.error(`\nError: ${message}\n${next}`);
        process.exit(1);
    };
    const read = async (message: string, hint: string, flag: string, echo: boolean): Promise<string> => {
        process.stdout.write(`${message}${hint}: `);
        reader ??= createInterface({ input: process.stdin });
        stdinLines ??= reader[Symbol.asyncIterator]();
        const line = await stdinLines.next();
        if (line.done) return fail(`No answer for "${message}".`, `Pass ${flag}.`);
        // Piped input is not echoed; without a newline every question would run onto one line.
        if (!process.stdin.isTTY) process.stdout.write(`${echo ? line.value : ''}\n`);
        return line.value;
    };
    return {
        intro: (title) => console.log(title),
        explain: () => {},
        ask: async ({ message, initial, validate, flag }) => {
            // An empty line keeps the default, so "-" is how an optional answer is cleared.
            const hint = initial ? ` [${initial}${validate('') ? '' : ', - for none'}]` : '';
            const line = (await read(message, hint, flag, true)).trim();
            const answer = line === '-' ? '' : line || initial;
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
        select: async ({ message, options, initial, flag }) => {
            const list = options.map(({ label }, index) => ` (${index + 1}) ${label}`).join('');
            const current = options.findIndex(({ value }) => value === initial) + 1;
            const answer = (await read(message, `${list} [${current}]`, flag, true)).trim();
            if (!answer) return initial;
            const chosen = options[Number(answer) - 1];
            return chosen ? chosen.value : fail(`Answer 1 to ${options.length} to "${message}".`, `Pass ${flag}.`);
        },
        password: async ({ message, validate, flag }) => {
            if (process.stdin.isTTY) return fail('A password typed here would show on screen.', `Pass ${flag}.`);
            const answer = await read(message, '', flag, false);
            const error = validate(answer);
            return error ? fail(error, `Pass ${flag}.`) : answer;
        },
        note: (title, lines) => console.log(`\n${title}\n${lines.map((line) => `  ${line}`).join('\n')}`),
        outro: (message) => {
            reader?.close();
            console.log(message);
        },
        fail,
    };
}
