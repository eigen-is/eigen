// What the collab info route answers an editor before it opens a document: what the caller may do, how they sync it,
// and the document's path with the parts of its container.

import type { DrivePath } from './drive';

export type CollabDocumentInfo = {
    canRead: boolean;
    canWrite: boolean;
    // Whether the caller syncs over the socket: signed in, and reading by name or allowed to write. Anyone else who
    // reads loads the stored state over HTTP.
    live: boolean;
    path: DrivePath | null;
    folderContents: DrivePath[] | null;
};
