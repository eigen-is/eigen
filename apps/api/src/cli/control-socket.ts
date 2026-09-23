import { getControlSocketPath } from '../lib/config/paths';
import type { Ui } from './ui';

// The online commands' one way into the running API: its private socket, reached through `docker compose exec`.
export async function callControl(path: string, fail: Ui['fail'], init?: RequestInit): Promise<Response> {
    try {
        return await fetch(`http://eigen${path}`, { ...init, unix: getControlSocketPath() });
    } catch {
        return fail(
            'Eigen is not answering.',
            'Wait a moment and try again, or run ./eigen logs eigen-api to see what it is doing.',
        );
    }
}
