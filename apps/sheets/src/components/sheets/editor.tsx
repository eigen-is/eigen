// The Sheets editor page: the Workbook grid over its collab document, with the toolbar, comments, chat, find and
// image and chart panels around it. SheetEditor is what the sheet route renders for one open workbook, and the grid
// it mounts takes its data and op log from useSheet.

import { useAuth } from '@workspace/lib/auth';
import { materializeClipboardSvg, needsReUpload, reUploadImage } from '@workspace/lib/clipboard';
import { useCommentFilter, useCommentLifecycle, useDocumentPanels } from '@workspace/lib/comments';
import { commentIndicatorColor } from '@workspace/lib/constants/comment-indicator';
import {
    isPendingMediaName,
    MediaResolverProvider,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
    useZombieMediaSweep,
} from '@workspace/lib/drive';
import type { SheetFloatingItem } from '@workspace/lib/sheets';
import { columnIndexToLabel } from '@workspace/lib/sheets';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { CardAttachmentDraft, CardFormPatch } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/drive';
import type { ImageSize } from '@workspace/lib/vector';
import { fitImageSize } from '@workspace/lib/vector';
import type { Cell, ChartPanelState, WorkbookInstance } from '@workspace/sheet';
import { ChartPanelSections, Workbook } from '@workspace/sheet';
import {
    CollabDocumentGate,
    DocumentShareCluster,
    FileDropOverlay,
    UnsyncedEditsGuard,
    useLayout,
} from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import type { CommentContextMenuItem } from '@workspace/ui/components/comments';
import { CommentLifecycleDialogs, PanelColumn } from '@workspace/ui/components/comments';
import { useContextMenu } from '@workspace/ui/components/context-menu';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { readImageSizeFromUrl } from '@workspace/ui/components/media';
import type { TransformFields } from '@workspace/ui/components/properties-panel';
import { useAspectLock } from '@workspace/ui/components/properties-panel';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useFileDropTarget } from '@workspace/ui/hooks/use-file-drop-target';
import { cn } from '@workspace/ui/lib/utils';
import { AlertTriangle, Image as ImageIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FloatingObjectPanel } from './floating-object-panel';
import { useActiveComments } from './hooks/use-active-comments';
import { usePresence } from './hooks/use-presence';
import { useSheetSearchController } from './hooks/use-search-controller';
import { useSheet } from './hooks/use-sheet';
import { ToolbarLeftItems } from './toolbar';

type SheetEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
};

export function SheetEditor(props: SheetEditorProps) {
    return (
        <MediaResolverProvider
            ownerId={props.ownerId}
            mountId={props.path.mountId}
            mediaFolderId={props.mediaFolderId}
            chatFolderId={props.chatFolderId}
        >
            <SheetEditorInner key={props.path.id} {...props} />
        </MediaResolverProvider>
    );
}

function SheetEditorInner({
    ownerId,
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
    initialSearchTerm,
}: SheetEditorProps) {
    const workbookRef = useRef<WorkbookInstance>(null);
    // The pane's box is the space a new image is fitted into. Sheets has no zoom, so a pixel of the pane
    // is a pixel of the sheet.
    const paneRef = useRef<HTMLDivElement>(null);
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    // The workbook reports the selected image or chart through onActiveObjectChange, and the properties
    // panel on the right shows it. Keep aspect ratio is on by default for an image and off for a chart.
    // The panel checkbox and the grips both read it, so it lives here, one level above both.
    const [activeObject, setActiveObject] = useState<SheetFloatingItem | null>(null);
    const [aspectLocked, setAspectLocked] = useAspectLock(
        activeObject ? [activeObject.object.id] : [],
        activeObject?.kind === 'image',
    );
    const [chartPanel, setChartPanel] = useState<ChartPanelState | null>(null);

    const {
        initialData,
        snapshotVersion,
        loadFailed,
        synced,
        offline,
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
        handleOp,
        docRef,
        provider,
    } = useSheet(ownerId, path.mountId, path.id, workbookRef);

    const auth = useAuth();
    const publishSelection = usePresence(provider, workbookRef, auth.user, synced, snapshotVersion);
    const { mutateAsync: copyToMediaFolder } = useCopyToMediaFolder(ownerId, path.mountId);
    const uploadFile = useUploadFile(ownerId, path.mountId);
    const { resolveMediaUrl, resolveMediaUrlByPath, resolveMediaPath, isMediaMissing, startUpload } =
        useMediaResolver();
    // On a phone the side panel would squeeze the workbook to about 130px, so the panel takes the whole
    // editor area instead. The engine measures its canvas again when the workbook shows again.
    const { isMobile } = useLayout();
    const {
        panel,
        commentPanelOpen,
        activityPanelOpen,
        mobilePanelOpen,
        toggleComments,
        toggleActivity,
        closePanels,
        onSearchOpenChange,
    } = useDocumentPanels(isMobile);
    const [addOpen, setAddOpen] = useState(false);
    const [addInitialTitle, setAddInitialTitle] = useState('');
    const [addTargetCell, setAddTargetCell] = useState<{ r: number; c: number } | null>(null);
    const [flowdata, setFlowdata] = useState<(Cell | null)[][] | undefined>();
    // Every Workbook onChange sets a new flowdata. The search controller keys on it, so an open search
    // runs again after each change to the document.
    const searchController = useSheetSearchController(workbookRef, flowdata, canWrite);
    const activeComments = useActiveComments(flowdata);
    const lifecycle = useCommentLifecycle({
        ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: docRef.current,
        activeCardIds: activeComments.ids,
        initialChatName,
        ready: synced,
    });
    const { allComments, cards, createCard, assignComment, members, assignedCount, setOpenCardId } = lifecycle;
    // The filter lives here, so it survives closing and opening the panel.
    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();

    const addCommentRef = useRef<(r: number, c: number) => void>(null);
    addCommentRef.current = useCallback((r: number, c: number) => {
        setAddTargetCell({ r, c });
        setAddInitialTitle(`Cell ${columnIndexToLabel(c)}${r + 1}`);
        setAddOpen(true);
    }, []);

    // A new image keeps its natural size when that fits in the visible pane, and shrinks to fit when it
    // does not. An image whose size can't be read gets the shared default box.
    const fitToPane = useCallback((intrinsic: ImageSize | null): ImageSize => {
        const rect = paneRef.current?.getBoundingClientRect();
        return fitImageSize(intrinsic, { width: rect?.width ?? 0, height: rect?.height ?? 0 });
    }, []);

    const handleImageFile = useCallback(
        async (file: File) => {
            if (!mediaFolderId || !file.type.startsWith('image/')) return;
            const { pendingName, promise } = startUpload(file);

            // The size is read before the upload is awaited, so the image is inserted before its pending
            // name is swapped for the real one. A swap that ran first would find nothing to rename, and the
            // zombie sweep would later delete the placeholder. A file without a size, such as some SVGs,
            // gets the default box.
            const bmp = await createImageBitmap(file).catch(() => null);
            const intrinsic = bmp ? { width: bmp.width, height: bmp.height } : null;
            bmp?.close();
            const { width, height } = fitToPane(intrinsic);
            workbookRef.current?.insertImage(pendingName, width, height);

            const result = await promise;
            if (result) workbookRef.current?.replaceImageMediaName(pendingName, result.name);
            else workbookRef.current?.removeImageByMediaName(pendingName);
        },
        [mediaFolderId, startUpload, fitToPane],
    );

    // An image copied from another Eigen editor lands at the size and angle it had there, so it is not
    // fitted to the pane. An image from another document is first placed under a pending name, then
    // re-uploaded into this sheet's media folder, and then renamed.
    const handlePasteEigenImage = useCallback(
        async (item: EigenClipboardImageItem) => {
            if (!mediaFolderId) return;
            const { width, height, angle } = item;
            if (needsReUpload(item.sourceParentId, mediaFolderId)) {
                const pendingName = `pending:${crypto.randomUUID()}`;
                workbookRef.current?.insertImage(pendingName, width, height, angle);
                const result = await reUploadImage(
                    item.sourcePathId,
                    item.sourceOwnerId,
                    item.sourceMountId,
                    mediaFolderId,
                    uploadFile.mutateAsync,
                    item.mediaName,
                );
                if (!result) {
                    workbookRef.current?.removeImageByMediaName(pendingName);
                    return;
                }
                workbookRef.current?.replaceImageMediaName(pendingName, result.mediaName);
                return;
            }
            workbookRef.current?.insertImage(item.mediaName, width, height, angle);
        },
        [mediaFolderId, uploadFile.mutateAsync],
    );

    // A pasted Vector drawing refers to its images by name. Each image is copied into this sheet's media
    // folder and the SVG is rewritten to point at the copies, before it is inserted as one image.
    const handlePasteSvgFile = useCallback(
        async (svg: string, imageItems: EigenClipboardImageItem[]) => {
            if (!mediaFolderId) return;
            const file = await materializeClipboardSvg(svg, imageItems, mediaFolderId, uploadFile.mutateAsync);
            await handleImageFile(file);
        },
        [mediaFolderId, uploadFile.mutateAsync, handleImageFile],
    );

    // A tab closed during an upload leaves an image with a pending name behind. The sweep removes those
    // images without an undo step, and skips a name that a finished upload has already replaced.
    useZombieMediaSweep({
        ready: synced,
        scan: () => {
            const workbook = workbookRef.current;
            if (!workbook) return [];
            const names: string[] = [];
            for (const sheet of workbook.getAllSheets()) {
                for (const img of Object.values(sheet.images ?? {})) {
                    if (isPendingMediaName(img.mediaName)) names.push(img.mediaName);
                }
            }
            return names;
        },
        remove: (names) => {
            for (const name of names) workbookRef.current?.removeImageByMediaName(name);
        },
    });

    const handleImageFromDevice = useCallback(
        (files: readonly File[]) => {
            const file = files[0];
            if (file) handleImageFile(file);
        },
        [handleImageFile],
    );

    // A file dropped from the desktop goes the same way as Insert image. handleImageFile skips anything
    // that is not an image.
    const { targetProps: imageDropProps, isDragging } = useFileDropTarget(
        handleImageFromDevice,
        canWrite && !!mediaFolderId,
    );

    const handleImagePickFromDrive = useCallback(
        async (paths: readonly DrivePath[]) => {
            if (!mediaFolderId || paths.length === 0) return;
            const copied = (await copyToMediaFolder({ paths: [paths[0]], mediaFolderId }).catch(() => null))?.[0];
            if (!copied) return;
            // Measure through the copy's own path. A lookup by name reads the media listing from before
            // the copy, misses the new file, and would size the image from the default box.
            const intrinsic = await readImageSizeFromUrl(resolveMediaUrlByPath(copied));
            const { width, height } = fitToPane(intrinsic);
            workbookRef.current?.insertImage(copied.name, width, height);
        },
        [mediaFolderId, copyToMediaFolder, resolveMediaUrlByPath, fitToPane],
    );

    const handleSaveNew = useCallback(
        async (patch: CardFormPatch, attachments?: CardAttachmentDraft[], assignee?: string | null) => {
            if (!addTargetCell || !workbookRef.current) return;
            const cell = addTargetCell;
            const card = await createCard({ title: addInitialTitle, ...patch, attachments }, (card) => {
                const fd = workbookRef.current?.getFlowdata();
                const existing = fd?.[cell.r]?.[cell.c]?.commentCardIds ?? [];
                workbookRef.current?.setCellFormat(cell.r, cell.c, 'commentCardIds', [...existing, card.id]);
            });
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setAddTargetCell(null);
            setAddOpen(false);
        },
        [addTargetCell, addInitialTitle, createCard, assignComment],
    );

    // Each edit is one op. The workbook then reports the written object again through onActiveObjectChange.
    const handleObjectTransform = useCallback(
        (fields: TransformFields) => {
            if (activeObject) {
                workbookRef.current?.updateFloatingBox({ kind: activeObject.kind, id: activeObject.object.id }, fields);
            }
        },
        [activeObject],
    );
    const beginObjectGesture = useCallback(() => workbookRef.current?.beginGesture() ?? (() => {}), []);
    const objectHistory = useMemo(
        () => ({ undo: () => workbookRef.current?.undo(), redo: () => workbookRef.current?.redo() }),
        [],
    );

    const leftItems = useMemo(
        () => <ToolbarLeftItems path={path} canWrite={canWrite} onAccessDialogOpen={onAccessDialogOpen} />,
        [path, canWrite, onAccessDialogOpen],
    );

    const rightItems = useMemo(
        () => (
            <DocumentShareCluster
                canWrite={canWrite}
                offline={offline}
                storageUnavailable={storageUnavailable}
                onAccessDialogOpen={onAccessDialogOpen}
                onToggleCommentPanel={toggleComments}
                commentPanelOpen={commentPanelOpen}
                onToggleActivityPanel={toggleActivity}
                activityPanelOpen={activityPanelOpen}
                assignedCommentCount={assignedCount}
                watchTarget={{ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id }}
            />
        ),
        [
            canWrite,
            offline,
            storageUnavailable,
            onAccessDialogOpen,
            commentPanelOpen,
            activityPanelOpen,
            assignedCount,
            path.ownerId,
            path.mountId,
            path.id,
        ],
    );

    // A WS blip keeps the Workbook mounted, and it catches up through the op log. A new snapshot remounts it through
    // snapshotVersion, unless it is a compaction of what the tab already holds.
    return (
        <CollabDocumentGate collab={{ loaded, storageUnavailable, storageGone }} path={path} canWrite={canWrite}>
            <UnsyncedEditsGuard active={unsyncedEdits} />
            {mediaFolderId && (
                <DrivePickerWithUpload
                    open={imagePickerOpen}
                    onOpenChange={setImagePickerOpen}
                    title="Insert image"
                    canPick={(item) => isImageMime(item.mimeType)}
                    onPickFromDrive={handleImagePickFromDrive}
                    onPickFromDevice={handleImageFromDevice}
                    accept="image/*"
                />
            )}
            <div className="flex h-full w-full flex-col overflow-hidden">
                {/* A sheet that failed to decode shows blank. Without this banner it would look like lost data. */}
                {loadFailed && (
                    <div className="flex shrink-0 items-center justify-center gap-2 border-b bg-destructive/10 app-gutter-x py-1.5 text-xs text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>
                            This spreadsheet could not be loaded. It is shown read-only so nothing gets overwritten.
                        </span>
                    </div>
                )}
                <div className="flex min-h-0 w-full flex-1 overflow-hidden">
                    {/* Hiding takes the find bar with it: it floats in this wrapper, outside the pane's Column. */}
                    <div className={cn('flex-1 overflow-hidden', mobilePanelOpen && 'hidden')}>
                        <DocSearchProvider
                            controller={searchController}
                            initialSearchTerm={initialSearchTerm}
                            onOpenChange={onSearchOpenChange}
                            barClassName="top-20"
                            onUndo={() => workbookRef.current?.undo()}
                            onRedo={() => workbookRef.current?.redo()}
                        >
                            <div ref={paneRef} className="relative h-full w-full" {...imageDropProps}>
                                <FileDropOverlay visible={isDragging} label="Drop images to add" icon={ImageIcon} />
                                {/* Set by the same sync that latches `loaded`; the check only narrows the type. */}
                                {initialData && (
                                    <Workbook
                                        key={snapshotVersion}
                                        ref={workbookRef}
                                        data={initialData}
                                        onChange={() => setFlowdata(workbookRef.current?.getFlowdata() ?? undefined)}
                                        onOp={handleOp}
                                        showToolbar={true}
                                        showFormulaBar={true}
                                        showSheetTabs={true}
                                        allowEdit={canWrite && !loadFailed}
                                        toolbarLeftItems={leftItems}
                                        toolbarRightItems={rightItems}
                                        aspectLocked={aspectLocked}
                                        hooks={{
                                            afterSelectionChange: (sheetId, selection) => {
                                                const r = selection.row_focus ?? selection.row?.[0];
                                                const c = selection.column_focus ?? selection.column?.[0];
                                                if (r != null && c != null) publishSelection(sheetId, r, c);
                                            },
                                            onActiveObjectChange: setActiveObject,
                                            onChartPanelChange: setChartPanel,
                                            ...(canWrite && mediaFolderId
                                                ? {
                                                      onInsertImage: () => setImagePickerOpen(true),
                                                      onPasteEigenImage: handlePasteEigenImage,
                                                      onPasteImageFile: handleImageFile,
                                                      onPasteSvgFile: handlePasteSvgFile,
                                                  }
                                                : {}),
                                            resolveImageUrl: resolveMediaUrl,
                                            isImageMissing: isMediaMissing,
                                            resolveImagePath: resolveMediaPath,
                                            ...(canWrite && chatFolderId
                                                ? {
                                                      onAddComment: (r: number, c: number) => {
                                                          addCommentRef.current?.(r, c);
                                                      },
                                                  }
                                                : {}),
                                            commentLifecycle: lifecycle,
                                            ...(canWrite
                                                ? {
                                                      onDeleteComment: (r: number, c: number) => {
                                                          const fd = workbookRef.current?.getFlowdata();
                                                          const cell = fd?.[r]?.[c];
                                                          const cardId = cell?.commentCardIds?.[0];
                                                          if (cardId && workbookRef.current) {
                                                              workbookRef.current.setCellFormat(
                                                                  r,
                                                                  c,
                                                                  'commentCardIds',
                                                                  (cell.commentCardIds ?? []).filter(
                                                                      (id) => id !== cardId,
                                                                  ),
                                                              );
                                                          }
                                                      },
                                                  }
                                                : {}),
                                            getCommentInfo: (r: number, c: number) => {
                                                const fd = workbookRef.current?.getFlowdata();
                                                const cardId = fd?.[r]?.[c]?.commentCardIds?.[0];
                                                const card = cardId ? cards[cardId] : undefined;
                                                if (!card) return null;
                                                const entry = card.chatName
                                                    ? allComments.find((c) => c.chatName === card.chatName)
                                                    : undefined;
                                                const indicatorColor = commentIndicatorColor(card.color);
                                                return { card, entry, indicatorColor };
                                            },
                                        }}
                                    />
                                )}
                            </div>
                        </DocSearchProvider>
                    </div>
                    {panel && auth.user && (
                        <PanelColumn
                            activePanel={panel}
                            onClose={closePanels}
                            path={path}
                            cards={cards}
                            entries={allComments}
                            members={members}
                            currentUserEmail={auth.user.email}
                            filter={commentFilter}
                            activeComments={activeComments}
                            commentContextMenu={commentContextMenu}
                            onOpenCard={setOpenCardId}
                        />
                    )}
                    {/* The comment and activity panels take the place of the properties panel, as in Slides. A
                        phone has no room for it. */}
                    {activeObject && !panel && !isMobile && (
                        <FloatingObjectPanel
                            item={activeObject}
                            canWrite={canWrite}
                            aspectLocked={aspectLocked}
                            onAspectLockChange={setAspectLocked}
                            onChange={handleObjectTransform}
                            onArrange={(op) =>
                                workbookRef.current?.reorderFloatingObject(
                                    { kind: activeObject.kind, id: activeObject.object.id },
                                    op,
                                )
                            }
                            beginGesture={beginObjectGesture}
                            history={objectHistory}
                        >
                            {chartPanel && (
                                <ChartPanelSections
                                    key={chartPanel.chart.id}
                                    panel={chartPanel}
                                    workbook={workbookRef}
                                />
                            )}
                        </FloatingObjectPanel>
                    )}
                </div>
            </div>

            <CardFormDialog
                open={addOpen}
                onOpenChange={(o) => {
                    setAddOpen(o);
                    if (!o) setAddTargetCell(null);
                }}
                initialTitle={addInitialTitle}
                onSave={handleSaveNew}
                allowAttachments={!!mediaFolderId}
                members={members}
                currentUserEmail={auth.user?.email}
                dialogTitle="New comment"
                submitLabel="Add comment"
            />

            <CommentLifecycleDialogs
                lifecycle={lifecycle}
                path={path}
                canWrite={canWrite}
                commentContextMenu={commentContextMenu}
                onDelete={(cardId) => {
                    const fd = workbookRef.current?.getFlowdata();
                    if (!fd) return;
                    for (const [r, row] of fd.entries()) {
                        for (const [c, cell] of (row ?? []).entries()) {
                            if (cell?.commentCardIds?.includes(cardId)) {
                                workbookRef.current?.setCellFormat(
                                    r,
                                    c,
                                    'commentCardIds',
                                    cell.commentCardIds.filter((id) => id !== cardId),
                                );
                            }
                        }
                    }
                }}
            />
        </CollabDocumentGate>
    );
}
