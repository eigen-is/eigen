import { DRIVE_MIME_DOC, DRIVE_MIME_SHEETS, DRIVE_MIME_SLIDES } from '@workspace/lib/types/drive';
import type { CollabTransformJob } from './transform/protocol';

// The collab document types a transform reads, keyed by the mime Drive stores. One
// list per fact: preview generation and search extraction both dispatch off it.
export type CollabDocumentType = CollabTransformJob['documentType'];

// Map, not Record: mimeType is document data — object lookup would resolve prototype keys.
export const COLLAB_DOCUMENT_TYPES = new Map<string, CollabDocumentType>([
    [DRIVE_MIME_DOC, 'eigendoc'],
    [DRIVE_MIME_SLIDES, 'eigenslides'],
    [DRIVE_MIME_SHEETS, 'eigensheets'],
]);
