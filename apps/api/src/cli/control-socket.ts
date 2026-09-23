import { getControlSocketPath } from '../lib/config/paths';
import type { Ui } from './ui';

// The online commands' one way into the running API: its private socket, reached through `docker compose exec`.
export async function callControl(path: string, fail: Ui['fail'], init?: RequestInit): Promise<Response> {
    try {
        return await fetch(`http://eigen${path}`, { ...init, unix: getControlSocketPath() });
    } catch {
        return fail(
            'The Eigen API is not answering.',
            'If it just started, wait a moment and try again. ./eigen logs eigen-api shows what it is doing.',
        );
    }
}
