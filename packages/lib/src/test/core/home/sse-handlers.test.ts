// Every open stream announces the data epochs of the user's homes, on open and with every keepalive. A tab reloads
// when one it already holds changes, which only a restore does: joining a team or reconnecting must not.
import { describe, expect, jest, test } from 'bun:test';
import { SSEventType } from '@workspace/lib/types/sse';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();
const reload = jest.fn();
// happy-dom's Location.reload navigates; the handler only has to call it.
Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });

const { handleHomeSSEvent } = await import('../../../core/home/sse-handlers');

function announce(epochs: Record<string, string>): boolean {
    return handleHomeSSEvent({ type: SSEventType.HOME_DATA_EPOCHS, epochs });
}

describe('handleHomeSSEvent', () => {
    test('reloads only when an epoch the tab already holds changes', () => {
        expect(announce({ user_a: 'server-1' })).toBe(true);
        expect(announce({ user_a: 'server-1' })).toBe(true);
        // A team joined after the tab loaded is a new home to it, not a replaced one.
        expect(announce({ user_a: 'server-1', team_b: 'server-1' })).toBe(true);
        expect(reload).not.toHaveBeenCalled();

        expect(announce({ user_a: 'server-1', team_b: 'server-1home-b' })).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('leaves every other event to the other handlers', () => {
        expect(handleHomeSSEvent({ type: SSEventType.NOTIFICATION_CHANGED })).toBe(false);
    });
});
