import { beforeAll, describe, expect, test } from 'bun:test';
import { auth } from '../../lib/auth/auth';
import { atHome, evictHome, getHome, touchHomeIfLoaded } from '../../lib/home/get-home';
import { getTestContext } from '../setup';

// An open collab websocket pins the doc-owner's home on each keepalive tick via touchHomeIfLoaded,
// so an actively-edited document can't idle-destruct underneath its connections. The helper must
// touch a loaded home but never re-hydrate one that has already been evicted (a stale tick).
describe('touchHomeIfLoaded (collab keepalive home pin)', () => {
    beforeAll(async () => {
        await getTestContext();
    });

    async function createHomeUser(email: string): Promise<string> {
        const signUp = await auth.api.signUpEmail({ body: { email, password: 'testpassword123', name: email } });
        return signUp.user.id;
    }

    test('resets the idle timer on a currently-loaded home', async () => {
        const userId = await createHomeUser('touch-pin-loaded@test.eigen.is');
        const home = await getHome(userId);

        let touchCalls = 0;
        const origTouch = home.touch.bind(home);
        home.touch = () => {
            touchCalls++;
            return origTouch();
        };

        touchHomeIfLoaded(userId);
        expect(touchCalls).toBe(1);

        home.touch = origTouch;
        await evictHome(userId);
    });

    test('is a no-op and does not hydrate a home that was never loaded', async () => {
        const userId = await createHomeUser('touch-pin-unloaded@test.eigen.is');
        expect(atHome(userId)).toBe(false);

        expect(() => touchHomeIfLoaded(userId)).not.toThrow();
        expect(atHome(userId)).toBe(false);
    });

    test('does not resurrect an evicted home', async () => {
        const userId = await createHomeUser('touch-pin-evicted@test.eigen.is');
        await getHome(userId);
        await evictHome(userId);
        expect(atHome(userId)).toBe(false);

        touchHomeIfLoaded(userId);
        expect(atHome(userId)).toBe(false);
    });
});
