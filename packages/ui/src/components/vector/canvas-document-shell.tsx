// The chrome both canvas apps wrap their canvas in, such as the leave guard, the find-bar session, the toolbar Column,
// the loading gate, the right slot under the toolbar, the image picker, and the comment dialogs and hover card. The
// right slot holds the properties panel, or the comments column while it is open; on a phone the column covers the
// canvas instead. What differs between the drawing app and the deck, such as the toolbar, the canvas area and the
// properties panel, arrives as props, so neither app owns a copy of this layout.

import type { DocSearchController } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/file-kinds';
import type { ReactNode, RefObject } from 'react';
import { CardFormDialog } from '../cards';
import { CommentHoverCard, CommentLifecycleDialogs, CommentsColumn } from '../comments';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';
import { CollabDocumentGate } from '../layout/app/collab-document-gate';
import { Column, ColumnLayout } from '../layout/app/column-layout';
import { columnWidthPx } from '../layout/app/column-widths';
import { useLayout } from '../layout/app/layout-context';
import { PhoneDetail } from '../layout/app/phone-detail';
import { UnsyncedEditsGuard } from '../layout/app/unsynced-edits-guard';
import { DocSearchProvider } from '../search/doc-search-provider';
import type { CanvasHandle } from './canvas-editor';
import type { CanvasCommentHost } from './hooks/use-canvas-comment-host';
import type { CanvasDoc } from './hooks/use-canvas-doc';

type CanvasDocumentShellProps = {
    doc: CanvasDoc;
    comments: CanvasCommentHost;
    path: DrivePath;
    canWrite: boolean;
    canEdit: boolean;
    mediaFolderId: string | null;
    searchController: DocSearchController;
    initialSearchTerm?: string;
    imagePickerOpen: boolean;
    onImagePickerOpenChange: (open: boolean) => void;
    canvasRef: RefObject<CanvasHandle | null>;
    toolbar: ReactNode;
    // Shown in the right slot while the comments column is closed; the host builds it because the deck adds its
    // slide-background section.
    propertiesPanel: ReactNode;
    // The canvas area itself, left of the right edge.
    children: ReactNode;
};

export function CanvasDocumentShell({
    doc,
    comments,
    path,
    canWrite,
    canEdit,
    mediaFolderId,
    searchController,
    initialSearchTerm,
    imagePickerOpen,
    onImagePickerOpenChange,
    canvasRef,
    toolbar,
    propertiesPanel,
    children,
}: CanvasDocumentShellProps) {
    const { isMobile, isTablet } = useLayout();
    const { column } = comments;
    const commentsColumn = column.open ? <CommentsColumn {...comments.columnProps} /> : null;
    // The find bar floats clear of whatever holds the right slot, plus its own 16px gutter. A phone's spans the screen.
    const rightPx = isMobile
        ? 0
        : column.open
          ? columnWidthPx(column.width, isTablet)
          : canEdit
            ? columnWidthPx('small')
            : 0;

    return (
        // Latched: a WS blip keeps the canvas mounted; `doc.synced` still gates presence.
        <CollabDocumentGate collab={doc} path={path} canWrite={canWrite}>
            <ColumnLayout>
                <UnsyncedEditsGuard active={doc.unsyncedEdits} />
                {/* On a phone the column covers the canvas, which stays mounted so Yjs state and selection survive the
                    visit. Hiding takes the find bar too: it floats in this wrapper. */}
                <PhoneDetail detail={commentsColumn}>
                    <div className="flex-1 min-w-0 h-full">
                        <DocSearchProvider
                            controller={searchController}
                            commentSearch={comments.commentSearch}
                            initialSearchTerm={initialSearchTerm}
                            onOpenChange={column.onSearchOpenChange}
                            barClassName="top-14"
                            barStyle={rightPx ? { right: rightPx + 16 } : undefined}
                        >
                            <Column
                                id="editor"
                                width="flex"
                                className="flex-1 h-full"
                                toolbarBorder="always"
                                toolbar={toolbar}
                            >
                                <div className="flex h-full w-full overflow-hidden">
                                    {children}
                                    {/* The column takes the properties panel's place while it is open. The panel stays
                                        up otherwise: with nothing selected it edits the canvas itself. */}
                                    {!isMobile && commentsColumn ? commentsColumn : canEdit ? propertiesPanel : null}
                                </div>

                                {mediaFolderId && (
                                    <DrivePickerWithUpload
                                        open={imagePickerOpen}
                                        onOpenChange={onImagePickerOpenChange}
                                        title="Insert image"
                                        canPick={(item) => isImageMime(item.mimeType)}
                                        multiSelect
                                        onPickFromDrive={(paths) =>
                                            void canvasRef.current?.insertDrivePaths(paths).catch(() => {})
                                        }
                                        onPickFromDevice={(files) => canvasRef.current?.insertFiles(files)}
                                        accept="image/*"
                                        multiple
                                    />
                                )}
                            </Column>
                        </DocSearchProvider>
                    </div>
                </PhoneDetail>

                <CardFormDialog
                    open={comments.addOpen}
                    onOpenChange={comments.closeAdd}
                    onSave={comments.handleSaveNew}
                    allowAttachments={!!mediaFolderId}
                    members={comments.members}
                    currentUserEmail={comments.currentUserEmail}
                    dialogTitle="New comment"
                    submitLabel="Add comment"
                />

                <CommentHoverCard side="right" {...comments.hoverCardProps} />

                <CommentLifecycleDialogs
                    lifecycle={comments.lifecycle}
                    canWrite={canWrite}
                    commentContextMenu={comments.commentContextMenu}
                    onDelete={comments.deleteCard}
                />
            </ColumnLayout>
        </CollabDocumentGate>
    );
}
