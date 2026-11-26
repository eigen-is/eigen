// What an editor reads about its document over HTTP: the caller's access with the document's path and parts, and,
// for a reader who gets no socket, the stored state, applied to the reader's Y.Doc as it arrives. An editor route asks
// the first, and useCollabDoc the second.

import { skipToken, useQuery } from '@tanstack/react-query';
import { collabApi, getCollabStateUrl } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import * as Y from 'yjs';
import { AppError, appErrorFrom } from '../../api-error';
import { collabStateEpoch } from '../collab-state';
import { collabKeys } from './keys';

// How long a failed read of the stored state waits before the next try.
const STORED_STATE_RETRY_MS = 5_000;

// The origin of the stored state's updates. It is not null, so no UndoManager tracks them.
const STORED_STATE_ORIGIN = 'stored-state';

// The version the doc holds, and whether the server's home was replaced since, which only a reload may follow.
type CollabStoredState = { etag: string; homeReplaced: boolean };

const NO_ACCESS: CollabDocumentInfo = {
    canRead: false,
    canWrite: false,
    live: false,
    path: null,
    folderContents: null,
};

export function useCollabDocumentInfo(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: collabKeys.document(ownerId, mountId, pathId),
        queryFn: async (): Promise<CollabDocumentInfo> => {
            const response = await collabApi({ ownerId })({ mountId })({ pathId }).info.get();

            if (response.error) {
                const error = new AppError(response);
                // Only a 401 or 403 is a verdict on this user. Anything else is a failure, and the route shows an
                // error instead of asking for access.
                if (error.status === 401 || error.status === 403) return NO_ACCESS;
                throw error;
            }

            return response.data;
        },
        enabled: !!ownerId && !!pathId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}

// The document's stored Yjs state, applied to `doc` and asked again whenever the tab shows again. Each ask names the
// ETag of the state the doc holds, so an unchanged document costs no body, and the query keeps only that ETag. A
// newer state of another epoch is not applied: the home was replaced, and the tab reloads as it does on a socket. A
// refusal is final; a failure is retried.
export function useCollabStoredState(ownerId: string, mountId: string, pathId: string, doc: Y.Doc | null) {
    return useQuery({
        queryKey: collabKeys.storedState(ownerId, mountId, pathId, doc?.guid ?? ''),
        queryFn: doc
            ? async ({ client, queryKey }): Promise<CollabStoredState> => {
                  const held = client.getQueryData<CollabStoredState>(queryKey);
                  const response = await fetch(getCollabStateUrl(ownerId, mountId, pathId), {
                      credentials: 'include',
                      headers: held ? { 'If-None-Match': held.etag } : {},
                  });
                  if (held && response.status === 304) return held;
                  if (!response.ok) throw await appErrorFrom(response);
                  const etag = response.headers.get('etag') ?? '';
                  if (held && collabStateEpoch(etag) !== collabStateEpoch(held.etag))
                      return { etag, homeReplaced: true };
                  Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()), STORED_STATE_ORIGIN);
                  return { etag, homeReplaced: false };
              }
            : skipToken,
        staleTime: 0,
        // A doc's key is never asked for again once its editor goes.
        gcTime: 0,
        retry: (_failures, error) => !(error instanceof AppError) || error.status >= 500,
        retryDelay: STORED_STATE_RETRY_MS,
    });
}
