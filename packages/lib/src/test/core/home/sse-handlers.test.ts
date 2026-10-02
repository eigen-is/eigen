// Every open stream announces the data epochs of the user's homes, on open and with every keepalive. A tab reloads
// when one it already holds changes, which only a restore does: joining a team or reconnecting must not.
import { beforeEach, describe, expect, jest, test } from 'bun:test';
import { SSEventType } from '@workspace/lib/types/sse';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();
const reload = jest.fn();
// happy-dom's Location.reload navigates; the handler only has to call it.
Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });

const HANDLERS = '../../../core/home/sse-handlers';
let pageLoads = 0;

// A page load: the module starts over, the tab's sessionStorage does not. The query makes bun evaluate it anew.
async function loadPage(): Promise<(epochs: Record<string, string>) => boolean> {
    pageLoads += 1;
    const { handleHomeSSEvent }: typeof import('../../../core/home/sse-handlers') = await import(
        `${HANDLERS}?load=${pageLoads}`
    );
    return (epochs) => handleHomeSSEvent({ type: SSEventType.HOME_DATA_EPOCHS, epochs });
}

beforeEach(() => {
    window.sessionStorage.clear();
    reload.mockClear();
});

describe('handleHomeSSEvent', () => {
    test('reloads only when an epoch the tab already holds changes', async () => {
        const announce = await loadPage();
        expect(announce({ user_a: 'server-1' })).toBe(true);
        expect(announce({ user_a: 'server-1' })).toBe(true);
        // A team joined after the tab loaded is a new home to it, not a replaced one.
        expect(announce({ user_a: 'server-1', team_b: 'server-1' })).toBe(true);
        expect(reload).not.toHaveBeenCalled();

        expect(announce({ user_a: 'server-1', team_b: 'server-1home-b' })).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    // A tab that stays on the leave prompt keeps its page: the epoch it reloaded for is already the one it holds.
    test('asks for the reload once per restore', async () => {
        const announce = await loadPage();
        announce({ user_a: 'server-1' });
        announce({ user_a: 'server-1home-a' });
        announce({ user_a: 'server-1home-a' });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('the page a reload brings up does not reload again', async () => {
        const announce = await loadPage();
        announce({ user_a: 'server-1' });
        announce({ user_a: 'server-1home-a' });
        expect(reload).toHaveBeenCalledTimes(1);

        (await loadPage())({ user_a: 'server-1home-a' });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    // An editor tab reloads when its collab socket names an epoch the restore replaced, before its event stream
    // announces the new one. The page it brings up must take that new epoch as the one it loaded under.
    test('a page reloaded by the collab socket takes the first epoch it hears', async () => {
        (await loadPage())({ user_a: 'server-1' });
        const { reloadReplacedHome } = await import('../../../core/home/reload-replaced-home');
        reloadReplacedHome();
        expect(reload).toHaveBeenCalledTimes(1);

        (await loadPage())({ user_a: 'server-1home-a' });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('leaves every other event to the other handlers', async () => {
        const { handleHomeSSEvent } = await import('../../../core/home/sse-handlers');
        expect(handleHomeSSEvent({ type: SSEventType.NOTIFICATION_CHANGED })).toBe(false);
    });
});
