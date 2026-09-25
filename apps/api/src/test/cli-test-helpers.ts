import { join } from 'node:path';

export const CLI = join(import.meta.dir, '../cli/index.ts');

// An undefined value removes the variable, so a test can drop NO_COLOR or EIGEN_PROJECT.
export type CliEnv = Record<string, string | undefined>;

type CliOptions = { cwd?: string; env?: CliEnv };

function spawnEnv(env: CliEnv = {}): Record<string, string> {
    const merged: CliEnv = { ...process.env, ...env };
    return Object.fromEntries(
        Object.entries(merged).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    );
}

// Piped, as a script runs it: stdin is `input`, or nothing.
export async function runCli(args: string[], { cwd, env, input }: CliOptions & { input?: string } = {}) {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
        cwd,
        env: spawnEnv(env),
        stdin: input === undefined ? 'ignore' : new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, code };
}

// In a pseudo-terminal; each answer's `keys` is typed once its `when` appears after the previous answer.
export async function runCliInTerminal(
    args: string[],
    { cwd, env }: CliOptions,
    answers: { when: string; keys: string }[] = [],
) {
    let output = '';
    let answered = 0;
    const pending = [...answers];
    const decoder = new TextDecoder();
    const { promise: closed, resolve } = Promise.withResolvers<void>();
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
        cwd,
        env: spawnEnv(env),
        terminal: {
            data: (terminal, data) => {
                output += decoder.decode(data);
                const next = pending[0];
                if (next && output.includes(next.when, answered)) {
                    answered = output.length;
                    terminal.write(next.keys);
                    pending.shift();
                }
            },
            exit: () => resolve(),
        },
    });
    const [code] = await Promise.all([proc.exited, closed]);
    proc.terminal?.close();
    return { output, code };
}
