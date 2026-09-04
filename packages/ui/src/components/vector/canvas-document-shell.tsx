// The chrome both canvas apps wrap their canvas in: the leave guard, the find-bar session, the
// toolbar Column, the loading gate, the right-edge pane/panel swap, the image picker and the two
// comment dialogs. What genuinely differs between the drawing app and the deck — the toolbar, the
// canvas area (slides adds its rail and slide-count footer) and the properties panel — arrives as
// props, so neither app owns a copy of this layout.

import type { DocSearchController } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode, RefObject } from 'react';
import { CardFormDialog } from '../cards';
import { CommentLifecycleDialogs, PanelColumn } from '../comments';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';
import { CollabLoadingState } from '../layout/app/collab-loading-state';
import { Column, ColumnLayout } from '../layout/app/column-layout';
import { useLayout } from '../layout/app/layout-context';
import { UnsyncedEditsGuard } from '../layout/app/unsynced-edits-guard';
import { DocSearchProvider } from '../search/doc-search-provider';
import type { CanvasImageInsert } from './canvas-editor';
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
    imageInsertRef: RefObject<CanvasImageInsert | null>;
    toolbar: ReactNode;
    // Shown on the right edge when the comment/activity pane is not; the host builds it because the
    // deck adds its slide-background section.
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
    imageInsertRef,
    toolbar,
    propertiesPanel,
    children,
}: CanvasDocumentShellProps) {
    const { isMobile } = useLayout();
    const { panel, mobilePanelOpen, panelProps } = comments;
    // A w-64 sibling occupies the right edge whenever the comment/activity pane or the properties
    // panel is up — inset the find bar clear of it.
    const rightPanelShown = (!isMobile && !!panel) || canEdit;

    return (
        <ColumnLayout>
            <UnsyncedEditsGuard active={doc.unsyncedEdits} />
            {/* The pane hides the canvas on mobile (a Column sibling below); keep the canvas mounted
                (hidden wrapper) so Yjs state and selection survive a pane visit. */}
            {/* Hiding takes the find bar with it: it floats in this wrapper, outside the Column. */}
            <div className={cn('flex-1 min-w-0 h-full', mobilePanelOpen && 'hidden')}>
                <DocSearchProvider
                    controller={searchController}
                    initialSearchTerm={initialSearchTerm}
                    onOpenChange={comments.onSearchOpenChange}
                    // right-68 = the w-64 right panel + the bar's own gutter.
                    barClassName={cn('top-14', rightPanelShown && 'right-68')}
                >
                    <Column id="editor" width="flex" className="flex-1 h-full" toolbarBorder="always" toolbar={toolbar}>
                        {/* Latched: a WS blip keeps the canvas mounted; `doc.synced` still gates presence. */}
                        {!doc.loaded ? (
                            <CollabLoadingState storageUnavailable={doc.storageUnavailable} />
                        ) : (
                            <div className="flex h-full w-full overflow-hidden">
                                {children}
                                {/* Right side: the comment/activity pane wins over the properties panel;
                                    mobile hosts the pane as an outside sibling. The panel stays up for the
                                    whole session — with nothing selected it edits the canvas itself. */}
                                {!isMobile && panel ? (
                                    <PanelColumn activePanel={panel} {...panelProps} />
                                ) : canEdit ? (
                                    propertiesPanel
                                ) : null}
                            </div>
                        )}

                        {mediaFolderId && (
                            <DrivePickerWithUpload
                                open={imagePickerOpen}
                                onOpenChange={onImagePickerOpenChange}
                                title="Add image"
                                mimeFilter={['image/*']}
                                multiSelect
                                onPickFromDrive={(paths) =>
                                    void imageInsertRef.current?.insertDrivePaths(paths).catch(() => {})
                                }
                                onPickFromDevice={(files) => imageInsertRef.current?.insertFiles(files)}
                                accept="image/*"
                                multiple
                            />
                        )}
                    </Column>
                </DocSearchProvider>
            </div>

            {mobilePanelOpen && panel && <PanelColumn activePanel={panel} {...panelProps} />}

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

            <CommentLifecycleDialogs
                lifecycle={comments.lifecycle}
                path={path}
                canWrite={canWrite}
                commentContextMenu={comments.commentContextMenu}
                onDelete={comments.deleteCard}
            />
        </ColumnLayout>
    );
}
