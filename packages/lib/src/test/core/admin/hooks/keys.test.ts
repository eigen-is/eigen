import { describe, expect, test } from 'bun:test';
import { adminKeys, invalidateTeamLists } from '../../../../core/admin/hooks/keys';
import { homeKeys } from '../../../../core/home/hooks/keys';
import { invalidatedBy } from '../../../invalidation';

// A team's name shows in the admin's team list, in each member's own team list and in the users page's team column.
describe('invalidateTeamLists', () => {
    test("refreshes the org's teams, the user's own teams and the admin's users", () => {
        const keys = invalidatedBy((queryClient) => invalidateTeamLists(queryClient, 'org-1'));

        expect(keys).toContainEqual([...adminKeys.teams('org-1')]);
        expect(keys).toContainEqual([...homeKeys.all]);
        expect(keys).toContainEqual([...adminKeys.users()]);
    });
});
