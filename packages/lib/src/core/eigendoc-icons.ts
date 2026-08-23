import type { EigenDocType } from '@workspace/lib/types/drive';
import { FileText, type LucideIcon, MessageSquare, PenTool, Presentation, Sheet, SquareKanban } from 'lucide-react';

// Sibling-of-EIGEN_DOC_TYPE_INFO icon registry. Kept out of types/drive.ts so that
// file stays type-only on the BE side (the API server only `import type`s from there).
// Single source for the lucide icon associated with each EigenDocType — file-presentation,
// drive-new-menu, eigendoc-config, and the command palette's create catalog all read it.
export const EIGEN_DOC_ICONS: Record<EigenDocType, LucideIcon> = {
    doc: FileText,
    stickies: SquareKanban,
    slides: Presentation,
    sheets: Sheet,
    chat: MessageSquare,
    vector: PenTool,
};
