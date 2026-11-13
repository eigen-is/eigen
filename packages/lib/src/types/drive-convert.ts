// How content moves between Drive files and documents: which office file converts to which document type, what an
// import of a file into a document takes and answers, the body of a copy, and the labels and summary header of an
// export. Routes such as convert and copy read them, and so do the file menus and file actions that call those routes.

import type { EigenDocType, ExportFormat } from './drive';

// What the convert route turns an office file into: the one format each target reads, by its extension alone, and the
// type of the document it makes. The file action offers a convert by the same extension the route refuses on.
export const CONVERT_SOURCES = {
    eigensheets: { format: 'xlsx', type: 'sheets' },
    eigendoc: { format: 'docx', type: 'doc' },
    eigenslides: { format: 'pptx', type: 'slides' },
} as const satisfies Record<string, { format: string; type: EigenDocType }>;
export type ConvertTarget = keyof typeof CONVERT_SOURCES;

export function isConvertTarget(t: string): t is ConvertTarget {
    return Object.hasOwn(CONVERT_SOURCES, t);
}

export function isConvertSource(name: string, target: ConvertTarget): boolean {
    return name.toLowerCase().endsWith(`.${CONVERT_SOURCES[target].format}`);
}

// What an import answers: `summary` says what the file held that did not come over, for a toast. A convert answers its
// new document's path alone, and shows no summary: the document opens at once.
export type ImportResult = { success: true; summary: string | null };

// An export answers with the file alone, so what the file left out rides in this header beside it, percent-encoded,
// for the toast after a download or a print. A file that lost nothing has no such header.
export const EXPORT_SUMMARY_HEADER = 'Eigen-Export-Summary';

// File › Import… puts the file beside what the document holds, such as slides after `afterFrameId`, or in its place
// after saving a version. A doc is only ever replaced: the file's page setup and headers can't sit beside the doc's.
export type ImportMode = 'insert' | 'replace';
export type DocumentImportOptions = { mode: ImportMode; afterFrameId?: string };

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
    docx: 'Microsoft Word (.docx)',
    xlsx: 'Microsoft Excel (.xlsx)',
    pptx: 'Microsoft PowerPoint (.pptx)',
    pdf: 'PDF (.pdf)',
    html: 'Web page (.html)',
};

// The Drive file an import-from-drive request names, and nothing about where it lands. Every format posts this one
// body, so the hooks and routes can't drift apart; importFromDriveSchema mirrors it.
export type DriveImportSource = { sourceOwnerId: string; sourceMountId: string; sourcePathId: string };

// Where a copy of a Drive item goes, and under which name: the body of the copy route.
export type DriveCopyDestination = {
    targetOwnerId: string;
    targetMountId: string;
    targetParentId: string;
    name?: string;
};
