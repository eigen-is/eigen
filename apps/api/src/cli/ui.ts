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
const GLYPHS = {
    ok: ['green', '◇'],
    warn: ['yellow', '▲'],
    bad: ['red', '■'],
    active: ['cyan', '◆'],
    start: ['gray', '┌'],
    bar: ['gray', '│'],
    end: ['gray', '└'],
} as const;

export type Glyph = keyof typeof GLYPHS;

// The launcher's say(): the glyph always, its color only on a terminal without NO_COLOR, which styleText ignores.
export function glyphLine(glyph: Glyph, text: string): string {
    const [color, mark] = GLYPHS[glyph];
    const shown = process.stdout.isTTY && !process.env['NO_COLOR'] ? styleText(color, mark) : mark;
    return text ? `${shown}  ${text}` : shown;
}

// Word-wraps each paragraph, since clack's log keeps its guide bar only on the lines it is given.
export function wrap(text: string, width: number): string[] {
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

// Clack only on a terminal, without flags or NO_COLOR (its styleText ignores it): a scripted run never loads it.
export async function createUi(flagsGiven: boolean): Promise<Ui> {
    const interactive = process.stdin.isTTY && process.stdout.isTTY && !flagsGiven;
    if (interactive && !process.env['NO_COLOR']) {
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
    // The launcher's die(), so an error reads the same whoever prints it.
    const fail = (message: string, next: string): never => {
        const [first = '', ...rest] = message.split('\n');
        console.error(
            [glyphLine('bad', first), ...rest.map((line) => glyphLine('bar', line)), glyphLine('end', next)].join('\n'),
        );
        process.exit(1);
    };
    // A person at a terminal with NO_COLOR gets the help clack would show, under the question.
    const read = async ({ message, help, flag }: Question, hint: string, echo: boolean): Promise<string> => {
        const lines = interactive && help ? wrap(help, 76).map((line) => `  ${line}`) : [];
        process.stdout.write(lines.length ? `${message}\n${lines.join('\n')}\n>${hint}: ` : `${message}${hint}: `);
        reader ??= createInterface({ input: process.stdin });
        stdinLines ??= reader[Symbol.asyncIterator]();
        const line = await stdinLines.next();
        if (line.done) {
            process.stdout.write('\n');
            return fail(`No answer for "${message}".`, `Pass ${flag}.`);
        }
        // Piped input is not echoed; without a newline every question would run onto one line.
        if (!process.stdin.isTTY) process.stdout.write(`${echo ? line.value : ''}\n`);
        return line.value;
    };
    return {
        intro: (title) => console.log(glyphLine('start', title)),
        explain: (text) => {
            if (interactive) console.log(wrap(text, 80).join('\n'));
        },
        ask: async ({ initial, validate, ...question }) => {
            const { flag } = question;
            // An empty line keeps the default, so "-" is how an optional answer is cleared.
            const hint = initial ? ` [${initial}${validate('') ? '' : ', - for none'}]` : '';
            const line = (await read(question, hint, true)).trim();
            const answer = line === '-' ? '' : line || initial;
            const error = validate(answer);
            return error ? fail(error, `Pass ${flag}.`) : answer;
        },
        confirm: async ({ initial, ...question }) => {
            const { message, flag } = question;
            const answer = (await read(question, initial ? ' [Y/n]' : ' [y/N]', true)).trim().toLowerCase();
            if (!answer) return initial;
            if (answer === 'y' || answer === 'yes') return true;
            if (answer === 'n' || answer === 'no') return false;
            return fail(`Answer y or n to "${message}".`, `Pass ${flag}.`);
        },
        select: async ({ options, initial, ...question }) => {
            const { message, flag } = question;
            const list = options.map(({ label }, index) => ` (${index + 1}) ${label}`).join('');
            const current = options.findIndex(({ value }) => value === initial) + 1;
            const answer = (await read(question, `${list} [${current}]`, true)).trim();
            if (!answer) return initial;
            const chosen = options[Number(answer) - 1];
            return chosen ? chosen.value : fail(`Answer 1 to ${options.length} to "${message}".`, `Pass ${flag}.`);
        },
        password: async ({ validate, ...question }) => {
            const { flag } = question;
            if (process.stdin.isTTY) return fail('A password typed here would show on screen.', `Pass ${flag}.`);
            const answer = await read(question, '', false);
            const error = validate(answer);
            return error ? fail(error, `Pass ${flag}.`) : answer;
        },
        note: (title, lines) =>
            console.log(
                [glyphLine('bar', ''), glyphLine('ok', title), ...lines.map((line) => glyphLine('bar', line))].join(
                    '\n',
                ),
            ),
        outro: (message) => {
            reader?.close();
            console.log(glyphLine('end', message));
        },
        fail,
    };
}
