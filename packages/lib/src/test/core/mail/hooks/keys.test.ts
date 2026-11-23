import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { homeKeys } from '../../../../core/home/hooks/keys';
import {
    emailKeys,
    invalidateMailDeleted,
    invalidateMailImported,
    mailboxKeys,
} from '../../../../core/mail/hooks/keys';
import { searchKeys } from '../../../../core/search';
import { invalidatedBy } from '../../../invalidation';

const OWNER = 'owner-1';
const MESSAGE = 'msg-1';

describe('emailKeys.previews', () => {
    // A part preview is the message's own cache: deleting or rewriting the message must drop it, or a
    // reopened id shows the part the old message had.
    test('a deleted message takes its part previews with it', () => {
        const queryClient = new QueryClient();
        const key = emailKeys.textPreview(OWNER, MESSAGE, 0);
        queryClient.setQueryData(key, { body: '<p>old</p>', mode: 'plaintext' });

        invalidateMailDeleted(queryClient, OWNER, MESSAGE, 'inbox');

        expect(queryClient.getQueryData(key)).toBeUndefined();
    });
});

// An imported message is bytes the home is charged for, the way a saved draft is — Home.size() counts
// the maildir. Nothing else on this branch changes what the counter sees.
describe('invalidateMailImported', () => {
    test('refreshes the lists, the unread counts, the home size and the search', () => {
        const keys = invalidatedBy((queryClient) => invalidateMailImported(queryClient, OWNER));

        expect(keys).toContainEqual([...emailKeys.lists(OWNER)]);
        expect(keys).toContainEqual([...mailboxKeys.lists(OWNER)]);
        expect(keys).toContainEqual([...homeKeys.size(OWNER)]);
        expect(keys).toContainEqual([...searchKeys.owner(OWNER)]);
    });
});
