// The one way the online commands, such as backup, status and reset-password, reach the running API: its private
// control socket, which the launcher enters through `docker compose exec`. A socket that does not answer ends the
// command with advice instead of a stack trace.

import { getControlSocketPath } from '../lib/config/paths';
import type { Ui } from './ui';

export async function callControl(path: string, fail: Ui['fail'], init?: BunFetchRequestInit): Promise<Response> {
    try {
        return await fetch(`http://eigen${path}`, { ...init, unix: getControlSocketPath() });
    } catch {
        return fail(
            'Eigen is not answering.',
            'Wait a moment and try again, or run ./eigen logs eigen-api to see what it is doing.',
        );
    }
}
