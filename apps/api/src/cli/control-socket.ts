import { getControlSocketPath } from '../lib/config/paths';
import type { Ui } from './ui';

// The online commands' one way into the running API: its private socket, reached through `docker compose exec`.
// No idle timeout: a pre-update backup waits out a running one in silence, and Bun's client would cut it at five minutes.
export async function callControl(path: string, fail: Ui['fail'], init?: RequestInit): Promise<Response> {
    try {
        return await fetch(`http://eigen${path}`, { ...init, unix: getControlSocketPath(), timeout: false });
    } catch {
        return fail(
            'Eigen is not answering.',
            'Wait a moment and try again, or run ./eigen logs eigen-api to see what it is doing.',
        );
    }
}
