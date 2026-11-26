// What an editor reads about its document over HTTP: the caller's access with the document's path and parts, and,
// for a reader who gets no socket, the stored state. An editor route asks the first, and useCollabDoc the second.

import { skipToken, useQuery } from '@tanstack/react-query';
import { collabApi, getCollabStateUrl } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import { AppError, appErrorFrom } from '../../api-error';
import { collabKeys } from './keys';

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
                // Only 401/403 are a verdict on this user (→ RequestAccessView). Anything else is a
                // failure: throw, so the route shows an error instead of asking for access.
                if (error.status === 401 || error.status === 403) return NO_ACCESS;
                throw error;
            }

            return response.data;
        },
        enabled: !!ownerId && !!pathId,
        staleTime: STALE_TIME.ONE_MINUTE,
    });
}

// How long a failed read of the stored state waits before the next try.
const STORED_STATE_RETRY_MS = 5_000;

type CollabStoredState = { etag: string; body: Uint8Array };

// The document's stored Yjs state, asked again whenever the tab shows again. Each ask names the ETag of the state it
// holds, so an unchanged document costs no body and keeps the object it had. A refusal is final; a failure is retried.
export function useCollabStoredState(ownerId: string, mountId: string, pathId: string, enabled: boolean) {
    return useQuery({
        queryKey: collabKeys.storedState(ownerId, mountId, pathId),
        queryFn: enabled
            ? async ({ client, queryKey }): Promise<CollabStoredState> => {
                  const held = client.getQueryData<CollabStoredState>(queryKey);
                  const response = await fetch(getCollabStateUrl(ownerId, mountId, pathId), {
                      credentials: 'include',
                      headers: held ? { 'If-None-Match': held.etag } : {},
                  });
                  if (held && response.status === 304) return held;
                  if (!response.ok) throw await appErrorFrom(response);
                  return {
                      etag: response.headers.get('etag') ?? '',
                      body: new Uint8Array(await response.arrayBuffer()),
                  };
              }
            : skipToken,
        staleTime: 0,
        // The body is as large as the document, so it goes with the editor.
        gcTime: 0,
        structuralSharing: false,
        retry: (_failures, error) => !(error instanceof AppError) || error.status >= 500,
        retryDelay: STORED_STATE_RETRY_MS,
    });
}
