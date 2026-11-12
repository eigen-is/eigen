// Handles the drive events from the stream: each names one path. The handler refreshes that path's own
// detail at once, and once per burst of events the owner's listings, such as its folders and the search
// results, and the viewer's lists of several owners' items, such as Recent. handleSSEvent calls it for every
// event, and it ignores the events of the other domains.

import type { QueryClient } from '@tanstack/react-query';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types/drive';
import type { SSEvent, SSEventTypeName } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateChatMatches } from '../chat/hooks/keys';
import { invalidateCollabDocument } from '../collab/hooks/keys';
import { debouncePerOwner } from '../debounce-per-owner';
import { invalidateSearchOwner } from '../search';
import { invalidateVersions } from '../versioning/hooks/keys';
import {
    driveKeys,
    forgetPath,
    invalidateAclSharedOrUnshared,
    invalidateAclUpdated,
    invalidateBreadcrumbs,
    invalidateEffectiveMembers,
    invalidateListings,
    invalidatePath,
    invalidateViewerLists,
} from './hooks/keys';
import { invalidateFileHistory } from './hooks/use-file-history';

// A chat found by its members depends on its ACL, its place and whether it is live. A folder's ACL
// reaches the chats below it, and the items below a trashed, restored or deleted folder send no events
// of their own. So these events on any path refresh the cached lookups, not only a chat's.
const CHAT_MATCH_EVENTS = new Set<SSEventTypeName>([
    SSEventType.DRIVE_ACL_SHARED,
    SSEventType.DRIVE_ACL_UNSHARED,
    SSEventType.DRIVE_ACL_UPDATED,
    SSEventType.DRIVE_PATH_MOVED,
    SSEventType.DRIVE_PATH_TRASHED,
    SSEventType.DRIVE_PATH_RESTORED,
    SSEventType.DRIVE_FOLDER_DELETED,
]);

// A burst, such as 500 files dropped into a team folder or a trash of 500 items emptied, sends every open
// tab of every member one event per item. Each invalidation restarts the open listing's fetch, and 500
// fetches per tab trip the server's per-IP rate limit, which the tabs of one office share. So the listings
// refetch once, after the burst, and every 1.5 s while a long upload goes on.
const invalidateListingsSoon = debouncePerOwner(
    (queryClient, ownerId) => {
        invalidateListings(queryClient, ownerId);
        invalidateBreadcrumbs(queryClient, ownerId);
        invalidateSearchOwner(queryClient, ownerId);
        invalidateFileHistory(queryClient, ownerId);
    },
    250,
    1500,
);

// Keyed by the viewer, whose lists these are, where the listings above are keyed by the path's owner.
const invalidateViewerListsSoon = debouncePerOwner(invalidateViewerLists, 250, 1500);

// The sidebar keeps every drive's trash list open, so only the events that change a trash refetch it.
const invalidateTrashSoon = debouncePerOwner(
    (queryClient, ownerId) => {
        queryClient.invalidateQueries({ queryKey: driveKeys.trash(ownerId) });
    },
    250,
    1500,
);

export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): void {
    if (!('path' in event)) return;
    const { path } = event;

    if (path.mimeType === DRIVE_MIME_CHAT || CHAT_MATCH_EVENTS.has(event.type)) {
        invalidateChatMatches(queryClient, userId);
    }

    switch (event.type) {
        case SSEventType.DRIVE_ACL_SHARED:
        case SSEventType.DRIVE_ACL_UNSHARED:
        case SSEventType.DRIVE_ACL_UPDATED:
            invalidateAclSharedOrUnshared(queryClient, userId);
            invalidateAclUpdated(queryClient, path);
            invalidateEffectiveMembers(queryClient, path.ownerId);
            invalidateFileHistory(queryClient, path.ownerId);
            return;

        // A restore and Delete history record a file event too, so the document's version list refetches with it.
        case SSEventType.DRIVE_FILE_HISTORY_UPDATED:
            invalidateFileHistory(queryClient, path.ownerId);
            invalidateVersions(queryClient, path.ownerId, path.mountId, path.id);
            return;

        // An open preview reads the path's detail: an overwrite changes its size, its thumbnail's cache-bust
        // and its text preview's key.
        case SSEventType.DRIVE_FILE_UPLOADED:
        case SSEventType.DRIVE_PATH_MOVED:
            invalidatePath(queryClient, path.ownerId, path.mountId, path.id);
            break;

        case SSEventType.DRIVE_PATH_RENAMED:
            invalidatePath(queryClient, path.ownerId, path.mountId, path.id);
            invalidateCollabDocument(queryClient, path.ownerId, path.mountId, path.id);
            break;

        case SSEventType.DRIVE_PATH_TRASHED:
        case SSEventType.DRIVE_FOLDER_DELETED:
        case SSEventType.DRIVE_FILE_DELETED:
            forgetPath(queryClient, path.ownerId, path.mountId, path.id);
            invalidateTrashSoon(queryClient, path.ownerId);
            break;

        case SSEventType.DRIVE_PATH_RESTORED:
            invalidateTrashSoon(queryClient, path.ownerId);
            break;
    }
    invalidateListingsSoon(queryClient, path.ownerId);
    invalidateViewerListsSoon(queryClient, userId);
}
