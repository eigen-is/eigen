import { afterEach } from 'bun:test';

// Puts each key back after every test, so an override never leaks into the next test or file sharing the process.
export function restoreEnvAfterEach(keys: string[]): void {
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    afterEach(() => {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}
