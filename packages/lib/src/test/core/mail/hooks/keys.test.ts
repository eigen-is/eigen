import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { emailKeys, invalidateMailDeleted } from '../../../../core/mail/hooks/keys';

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
