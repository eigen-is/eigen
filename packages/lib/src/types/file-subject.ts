import type { DrivePath } from './drive';

// One file a surface can act on, whatever holds it: a Drive item today, a mail part next. The URLs
// are built once, by the builders in core/file-subject.ts, so no consumer composes a route by hand.
export type FileSubject = {
    // Identity for sibling matching: drive:{ownerId}:{mountId}:{id}.
    key: string;
    name: string;
    mimeType: string;
    size: number;
    embedUrl: string;
    // Absent when there are no raw bytes to hand out — a folder, an Eigen container.
    downloadUrl?: string;
    thumbnailUrl?: string;
    // Present: Open, the server-rendered previews, and every Drive-side action.
    drive?: DrivePath;
};
