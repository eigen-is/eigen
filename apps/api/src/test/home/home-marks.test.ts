import { beforeAll, describe, expect, test } from 'bun:test';
import { ApiError } from '../../lib/core/errors';
import { clearHomeDeleting, getHome, markHomeDeleting, markHomeRestoring } from '../../lib/home/get-home';
import type { TestUser } from '../setup';
import { createTestUser, getTestContext } from '../setup';

// A deletion marks its home before it removes the folder, and keeps the mark until better-auth has deleted the
// owner's row. A restore that took the home in that window would install a folder the deletion is removing, for an
// owner about to be gone. Every restore takes the home through markHomeRestoring, so that is where it is refused.
describe('A restore while the home is being deleted', () => {
    let owner: TestUser;

    beforeAll(async () => {
        await getTestContext();
        owner = await createTestUser('home-marks-deleting@test.eigen.is', 'testpassword123', 'Being Deleted');
    });

    test('is refused with a 409, and leaves no restore mark behind', async () => {
        markHomeDeleting(owner.id);
        let refusal: unknown;
        try {
            markHomeRestoring(owner.id);
        } catch (error) {
            refusal = error;
        } finally {
            clearHomeDeleting(owner.id);
        }
        expect(refusal).toBeInstanceOf(ApiError);
        expect(refusal).toMatchObject({ status: 409, message: 'A deletion of this home is running' });
        // A mark left behind would answer every request with the 503 of a restore.
        expect((await getHome(owner.id)).user.id).toBe(owner.id);
    });
});
