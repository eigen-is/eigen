import { useAuth } from '@workspace/lib/auth';
import { materializeClipboardSvg, needsReUpload, reUploadImage } from '@workspace/lib/clipboard';
import { useCommentFilter, useCommentLifecycle, useDocumentPanels } from '@workspace/lib/comments';
import { EIGEN_STICKIES_INDICATOR_MAP } from '@workspace/lib/constants/colors';
import {
    isPendingMediaName,
    MediaResolverProvider,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
    useZombieMediaSweep,
} from '@workspace/lib/drive';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { fitImageSize, type ImageSize } from '@workspace/lib/vector';
import { type Image as SheetImage, Workbook, type WorkbookInstance } from '@workspace/sheet';
import { DocumentShareCluster, FileDropOverlay, LoadingState, useLayout } from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import type { CommentContextMenuItem } from '@workspace/ui/components/comments';
import { CommentLifecycleDialogs, PanelColumn } from '@workspace/ui/components/comments';
import { useContextMenu } from '@workspace/ui/components/context-menu';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { readImageSizeFromUrl } from '@workspace/ui/components/media';
import { type TransformFields, useAspectLock } from '@workspace/ui/components/properties-panel';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useFileDropTarget } from '@workspace/ui/hooks/use-file-drop-target';
import { cn } from '@workspace/ui/lib/utils';
import { AlertTriangle, Image as ImageIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { columnToLetter, useActiveComments } from './hooks/use-active-comments';
import { usePresence } from './hooks/use-presence';
import { useSheetSearchController } from './hooks/use-search-controller';
import { useSheet } from './hooks/use-sheet';
import { ImagePropertiesPanel } from './image-properties-panel';
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
    // The workbook-pane wrapper — its box is the "visible pane" viewport for image-fit sizing. Sheets
    // has no zoom, so container px map 1:1 to the sheet-pixel units insertImage stores.
    const paneRef = useRef<HTMLDivElement>(null);
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    // The active floating image (surfaced from the workbook via onActiveImageChange) drives the
    // right-side properties panel. Its aspect-lock — images default CHECKED — feeds BOTH the
    // panel checkbox and the canvas ObjectTransform, so it lives here, one level above both.
    const [activeImage, setActiveImage] = useState<SheetImage | null>(null);
    const [imageAspectLocked, setImageAspectLocked] = useAspectLock(activeImage?.id ?? '', true);

    const { initialData, snapshotVersion, loadFailed, synced, offline, handleOp, onDataChange, docRef, provider } =
        useSheet(ownerId, path.mountId, path.id, workbookRef);

    const auth = useAuth();
    const publishSelection = usePresence(provider, workbookRef, auth.user, synced, snapshotVersion);
    const copyToMediaFolder = useCopyToMediaFolder(ownerId, path.mountId);
    const uploadFile = useUploadFile(ownerId, path.mountId);
    const { resolveMediaUrl, resolveMediaUrlByPath, resolveMediaPath, startUpload } = useMediaResolver();
    // Below the breakpoint the w-64 sibling squeezes the workbook to ~130px, so the pane takes the
    // editor area over instead; the engine re-measures its canvas when the workbook is un-hidden.
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
    const [flowdata, setFlowdata] = useState<(import('@workspace/sheet').Cell | null)[][] | undefined>();
    // flowdata is the republish identity key — set from every Workbook onChange, so the controller
    // re-publishes per document change and the provider re-runs the open search (contract rule 4).
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
    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();

    const addCommentRef = useRef<(r: number, c: number) => void>(null);
    addCommentRef.current = useCallback((r: number, c: number) => {
        setAddTargetCell({ r, c });
        setAddInitialTitle(`Cell ${columnToLetter(c)}${r + 1}`);
        setAddOpen(true);
    }, []);

    // Size a placed image to fit the visible pane via the shared helper — natural size where it
    // fits within 80% of the pane, never upscaled; unreadable intrinsic → the shared default box.
    // Replaces insertImage's old halve-natural-dims quirk (killed in state/modules/image.ts).
    const fitToPane = useCallback((intrinsic: ImageSize | null): ImageSize => {
        const rect = paneRef.current?.getBoundingClientRect();
        return fitImageSize(intrinsic, { width: rect?.width ?? 0, height: rect?.height ?? 0 });
    }, []);

    const handleImageFile = useCallback(
        async (file: File) => {
            if (!mediaFolderId || !file.type.startsWith('image/')) return;
            const { pendingName, promise } = startUpload(file);

            // Read the intrinsic px (vector's createImageBitmap idiom; rejects on e.g. a
            // dimensionless SVG → null → the shared default box). Awaited BEFORE the upload result
            // so the insert always precedes the pending→real mediaName swap — a swap that ran first
            // would no-op and strand the insert as a placeholder for the zombie sweep to delete.
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

    // Consume a pasted eigen image item (from sheets/slides/vector/docs) as a floating image. The
    // typed width/height/angle are AUTHORITATIVE — no fit-to-pane, no probing: the wire always
    // carries both dims, so the image lands at its source box on the first paint. Cross-mount inserts
    // a pending placeholder at that same exact box, re-uploads into our media/, then swaps the name.
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

    // Consume a pasted vector SVG whose images are name-referenced (eigen-media:): materialize each
    // into our media/ (re-uploading cross-container via the same seam as handlePasteEigenImage) and
    // rewrite the svg's refs, then insert the rewritten svg as one floating image through the normal
    // image path.
    const handlePasteSvgFile = useCallback(
        async (svg: string, imageItems: EigenClipboardImageItem[]) => {
            if (!mediaFolderId) return;
            const file = await materializeClipboardSvg(svg, imageItems, mediaFolderId, uploadFile.mutateAsync);
            await handleImageFile(file);
        },
        [mediaFolderId, uploadFile.mutateAsync, handleImageFile],
    );

    // Sweep zombie placeholders left behind by a tab close or reload mid-upload. Snapshot pending
    // mediaNames over the imperative workbook API; removeImageByMediaName is noUndo (correct for a
    // sweep) and no-ops on a name a completed upload already swapped away.
    useZombieMediaSweep({
        ready: synced,
        scan: () => {
            const workbook = workbookRef.current;
            if (!workbook) return [];
            const names: string[] = [];
            for (const sheet of workbook.getAllSheets()) {
                for (const img of sheet.images ?? []) {
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
        (files: File[]) => {
            const file = files[0];
            if (file) handleImageFile(file);
        },
        [handleImageFile],
    );

    // OS-file drop → the same insert path as the Insert-image menu (handleImageFile guards non-images).
    const { targetProps: imageDropProps, isDragging } = useFileDropTarget(
        handleImageFromDevice,
        canWrite && !!mediaFolderId,
    );

    const handleImagePickFromDrive = useCallback(
        async (paths: DrivePath[]) => {
            if (!mediaFolderId || paths.length === 0) return;
            const result = await copyToMediaFolder.mutateAsync({ paths: [paths[0]], mediaFolderId }).catch(() => null);
            if (!result?.[0]) return;
            // Measure via the copy result's own path — by NAME the lookup would miss the media
            // listing captured before the copy and size the image from the default box.
            const intrinsic = await readImageSizeFromUrl(resolveMediaUrlByPath(result[0]));
            const { width, height } = fitToPane(intrinsic);
            workbookRef.current?.insertImage(result[0].name, width, height);
        },
        [mediaFolderId, copyToMediaFolder, resolveMediaUrlByPath, fitToPane],
    );

    const handleSaveNew = useCallback(
        async (
            patch: { title?: string; description?: string; color?: string },
            attachments?: CardAttachmentDraft[],
            assignee?: string | null,
        ) => {
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

    // One op per edit; the workbook re-surfaces the committed image via onActiveImageChange.
    const handleImageTransform = useCallback(
        (fields: TransformFields) => {
            if (activeImage) workbookRef.current?.updateImage(activeImage.id, fields);
        },
        [activeImage],
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
            onAccessDialogOpen,
            commentPanelOpen,
            activityPanelOpen,
            assignedCount,
            path.ownerId,
            path.mountId,
            path.id,
        ],
    );

    // initialData is the load latch, deliberately NOT `synced`: the shared useCollabDoc flips
    // `synced` false on a WS blip and true on reconnect, and unmounting the Workbook there would
    // drop the engine undo stack and any in-progress cell edit. The mounted workbook catches up via
    // the op-log observer (and a remote snapshot flush remounts through snapshotVersion).
    if (!initialData) {
        return <LoadingState />;
    }

    return (
        <>
            {mediaFolderId && (
                <DrivePickerWithUpload
                    open={imagePickerOpen}
                    onOpenChange={setImagePickerOpen}
                    title="Insert image"
                    mimeFilter={['image/*']}
                    onPickFromDrive={handleImagePickFromDrive}
                    onPickFromDevice={handleImageFromDevice}
                    accept="image/*"
                />
            )}
            <div className="flex h-full w-full flex-col overflow-hidden">
                {/* Persistent read-only signal — a decode failure leaves a blank sheet otherwise
                    indistinguishable from data loss (a dismissible toast was not enough). */}
                {loadFailed && (
                    <div className="flex shrink-0 items-center justify-center gap-2 border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
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
                                <Workbook
                                    key={snapshotVersion}
                                    ref={workbookRef}
                                    data={initialData}
                                    onChange={(data) => {
                                        onDataChange(data);
                                        setFlowdata(workbookRef.current?.getFlowdata() ?? undefined);
                                    }}
                                    onOp={handleOp}
                                    showToolbar={true}
                                    showFormulaBar={true}
                                    showSheetTabs={true}
                                    allowEdit={canWrite && !loadFailed}
                                    toolbarLeftItems={leftItems}
                                    toolbarRightItems={rightItems}
                                    defaultRowHeight={20}
                                    defaultFontSize={10}
                                    defaultColWidth={100}
                                    imageAspectLocked={imageAspectLocked}
                                    hooks={{
                                        afterSelectionChange: (sheetId, selection) => {
                                            const r = selection.row_focus ?? selection.row?.[0];
                                            const c = selection.column_focus ?? selection.column?.[0];
                                            if (r != null && c != null) publishSelection(sheetId, r, c);
                                        },
                                        onActiveImageChange: setActiveImage,
                                        ...(canWrite && mediaFolderId
                                            ? {
                                                  onInsertImage: () => setImagePickerOpen(true),
                                                  onPasteEigenImage: handlePasteEigenImage,
                                                  onPasteImageFile: handleImageFile,
                                                  onPasteSvgFile: handlePasteSvgFile,
                                              }
                                            : {}),
                                        resolveImageUrl: resolveMediaUrl,
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
                                                              (cell.commentCardIds ?? []).filter((id) => id !== cardId),
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
                                            const indicatorColor = card.color
                                                ? (EIGEN_STICKIES_INDICATOR_MAP.get(card.color) ?? card.color)
                                                : null;
                                            return { card, entry, indicatorColor };
                                        },
                                    }}
                                />
                            </div>
                        </DocSearchProvider>
                    </div>
                    {panel && (
                        <PanelColumn
                            activePanel={panel}
                            onClose={closePanels}
                            path={path}
                            cards={cards}
                            entries={allComments}
                            members={members}
                            currentUserEmail={auth.user!.email}
                            filter={commentFilter}
                            activeComments={activeComments}
                            commentContextMenu={commentContextMenu}
                            onOpenCard={setOpenCardId}
                        />
                    )}
                    {/* The comment/activity pane wins over the properties panel (the slides arrangement). */}
                    {activeImage && !panel && (
                        <ImagePropertiesPanel
                            image={activeImage}
                            canWrite={canWrite}
                            aspectLocked={imageAspectLocked}
                            onAspectLockChange={setImageAspectLocked}
                            onChange={handleImageTransform}
                            onDelete={() => workbookRef.current?.removeActiveImage()}
                        />
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
                    for (let r = 0; r < fd.length; r++) {
                        const row = fd[r];
                        if (!row) continue;
                        for (let c = 0; c < row.length; c++) {
                            const cell = row[c];
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
        </>
    );
}
