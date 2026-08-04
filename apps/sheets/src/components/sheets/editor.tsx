import { useAuth } from '@workspace/lib/auth';
import { useCommentFilter, useCommentLifecycle, useDocumentPanels } from '@workspace/lib/comments';
import { EIGEN_STICKIES_INDICATOR_MAP } from '@workspace/lib/constants/colors';
import {
    isPendingMediaName,
    MediaResolverProvider,
    useCopyToMediaFolder,
    useMediaResolver,
} from '@workspace/lib/drive';
import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Workbook, type WorkbookInstance } from '@workspace/sheet';
import {
    ActivityPanel,
    CardFormDialog,
    CommentLifecycleDialogs,
    CommentPanel,
    LoadingState,
    MobilePanelColumn,
    useLayout,
} from '@workspace/ui';
import type { CommentContextMenuItem } from '@workspace/ui/components/layout/comments';
import { useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { DrivePickerWithUpload } from '@workspace/ui/components/layout/drive/drive-picker-with-upload';
import { DocSearchProvider } from '@workspace/ui/components/layout/search/doc-search-provider';
import { DocumentShareCluster } from '@workspace/ui/components/layout/toolbar';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { columnToLetter, useActiveComments } from './hooks/use-active-comments';
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
            <SheetEditorInner {...props} />
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
    const [imagePickerOpen, setImagePickerOpen] = useState(false);

    const { initialData, snapshotVersion, synced, handleOp, onDataChange, docRef, provider } = useSheet(
        ownerId,
        path.mountId,
        path.id,
        workbookRef,
    );

    const auth = useAuth();
    const publishSelection = usePresence(provider, workbookRef, auth.user, synced, snapshotVersion);
    const copyToMediaFolder = useCopyToMediaFolder(ownerId, path.mountId);
    const { resolveMediaUrl, startUpload } = useMediaResolver();
    const { panel, commentPanelOpen, activityPanelOpen, toggleComments, toggleActivity, closePanels } =
        useDocumentPanels();
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
    const {
        allComments,
        resolveComment,
        cards,
        createCard,
        updateCard,
        assignComment,
        members,
        unresolvedCount,
        setOpenCardId,
    } = lifecycle;
    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();

    const addCommentRef = useRef<(r: number, c: number) => void>(null);
    addCommentRef.current = useCallback((r: number, c: number) => {
        setAddTargetCell({ r, c });
        setAddInitialTitle(`Cell ${columnToLetter(c)}${r + 1}`);
        setAddOpen(true);
    }, []);

    const handleImageFile = useCallback(
        async (file: File) => {
            if (!mediaFolderId || !file.type.startsWith('image/')) return;
            const { pendingName, promise } = startUpload(file);

            // Read natural dimensions so the workbook can size the inserted image correctly.
            const objectUrl = URL.createObjectURL(file);
            const img = new window.Image();
            img.onload = () => {
                workbookRef.current?.insertImage(pendingName, img.naturalWidth, img.naturalHeight);
                URL.revokeObjectURL(objectUrl);
            };
            img.onerror = () => {
                workbookRef.current?.insertImage(pendingName, 200, 200);
                URL.revokeObjectURL(objectUrl);
            };
            img.src = objectUrl;

            const result = await promise;
            if (result) workbookRef.current?.replaceImageMediaName(pendingName, result.name);
            else workbookRef.current?.removeImageByMediaName(pendingName);
        },
        [mediaFolderId, startUpload],
    );

    // Sweep zombie placeholders left behind by a tab close or reload mid-upload.
    useEffect(() => {
        if (!synced) return;
        const workbook = workbookRef.current;
        if (!workbook) return;
        const snapshot: string[] = [];
        for (const sheet of workbook.getAllSheets()) {
            for (const img of sheet.images ?? []) {
                if (isPendingMediaName(img.mediaName)) snapshot.push(img.mediaName);
            }
        }
        if (snapshot.length === 0) return;
        const timer = setTimeout(() => {
            for (const mediaName of snapshot) {
                workbookRef.current?.removeImageByMediaName(mediaName);
            }
        }, 60_000);
        return () => clearTimeout(timer);
    }, [synced]);

    const handleImageFromDevice = useCallback(
        (files: File[]) => {
            const file = files[0];
            if (file) handleImageFile(file);
        },
        [handleImageFile],
    );

    const handleImagePickFromDrive = useCallback(
        async (paths: DrivePath[]) => {
            if (!mediaFolderId || paths.length === 0) return;
            const result = await copyToMediaFolder.mutateAsync({ paths: [paths[0]], mediaFolderId }).catch(() => null);
            if (!result?.[0]) return;
            const mediaName = result[0].name;
            const previewUrl = resolveMediaUrl(mediaName);
            if (!previewUrl) {
                workbookRef.current?.insertImage(mediaName, 200, 200);
                return;
            }
            const img = new window.Image();
            img.onload = () => workbookRef.current?.insertImage(mediaName, img.naturalWidth, img.naturalHeight);
            img.onerror = () => workbookRef.current?.insertImage(mediaName, 200, 200);
            img.src = previewUrl;
        },
        [mediaFolderId, copyToMediaFolder, resolveMediaUrl],
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

    const leftItems = useMemo(
        () => <ToolbarLeftItems path={path} canWrite={canWrite} onAccessDialogOpen={onAccessDialogOpen} />,
        [path, canWrite, onAccessDialogOpen],
    );

    const rightItems = useMemo(
        () => (
            <DocumentShareCluster
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onToggleCommentPanel={toggleComments}
                commentPanelOpen={commentPanelOpen}
                onToggleActivityPanel={toggleActivity}
                activityPanelOpen={activityPanelOpen}
                unresolvedCommentCount={unresolvedCount}
                watchTarget={{ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id }}
            />
        ),
        [
            canWrite,
            onAccessDialogOpen,
            commentPanelOpen,
            activityPanelOpen,
            unresolvedCount,
            path.ownerId,
            path.mountId,
            path.id,
        ],
    );

    // Below the breakpoint the w-64 sibling squeezes the workbook to ~130px, so the pane takes the
    // editor area over instead; the engine re-measures its canvas when the workbook is un-hidden.
    const { isMobile } = useLayout();
    const mobilePanelOpen = isMobile && panel !== null;

    // The find bar rides with the workbook, which the pane hides — a session opened from over the
    // pane (⌘F, a palette in-document hit) would be invisible. Reveal the workbook instead; the
    // pane is one toolbar tap away.
    const handleSearchOpenChange = useCallback(
        (open: boolean) => {
            if (open && isMobile) closePanels();
        },
        [isMobile, closePanels],
    );

    if (!synced || !initialData) {
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
            <div className="flex h-full w-full overflow-hidden">
                {/* Hiding takes the find bar with it: the bar floats inside this wrapper, outside the
                    pane's Column, and would otherwise paint over the pane. */}
                <div className={cn('flex-1 overflow-hidden', mobilePanelOpen && 'hidden')}>
                    <DocSearchProvider
                        controller={searchController}
                        initialSearchTerm={initialSearchTerm}
                        onOpenChange={handleSearchOpenChange}
                        barClassName="top-20"
                        onUndo={() => workbookRef.current?.undo()}
                        onRedo={() => workbookRef.current?.redo()}
                    >
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
                            allowEdit={canWrite}
                            toolbarLeftItems={leftItems}
                            toolbarRightItems={rightItems}
                            defaultRowHeight={20}
                            defaultFontSize={10}
                            defaultColWidth={100}
                            hooks={{
                                afterSelectionChange: (sheetId, selection) => {
                                    const r = selection.row_focus ?? selection.row?.[0];
                                    const c = selection.column_focus ?? selection.column?.[0];
                                    if (r != null && c != null) publishSelection(sheetId, r, c);
                                },
                                ...(canWrite && mediaFolderId ? { onInsertImage: () => setImagePickerOpen(true) } : {}),
                                resolveImageUrl: resolveMediaUrl,
                                ...(canWrite && chatFolderId
                                    ? {
                                          onAddComment: (r: number, c: number) => {
                                              addCommentRef.current?.(r, c);
                                          },
                                      }
                                    : {}),
                                onViewComment: (r: number, c: number) => {
                                    const fd = workbookRef.current?.getFlowdata();
                                    const cardId = fd?.[r]?.[c]?.commentCardIds?.[0];
                                    if (cardId) setOpenCardId(cardId);
                                },
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
                                          onCommentColor: (r: number, c: number, color: string) => {
                                              const fd = workbookRef.current?.getFlowdata();
                                              const cardId = fd?.[r]?.[c]?.commentCardIds?.[0];
                                              if (cardId) updateCard(cardId, { color });
                                          },
                                          onCommentResolve: (chatName: string, title?: string) =>
                                              resolveComment.mutate({ chatName, status: 'resolved', title }),
                                          onCommentReopen: (chatName: string, title?: string) =>
                                              resolveComment.mutate({ chatName, status: 'open', title }),
                                          onCommentAssign: (chatName, email, title) =>
                                              assignComment.mutate({ chatName, assignee: email, title }),
                                          commentMembers: members,
                                          currentUserEmail: auth.user?.email,
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
                    </DocSearchProvider>
                </div>
                {mobilePanelOpen ? (
                    <MobilePanelColumn
                        activePanel={panel}
                        onBack={closePanels}
                        path={path}
                        lifecycle={lifecycle}
                        activeComments={activeComments}
                        filter={commentFilter}
                        commentContextMenu={commentContextMenu}
                        onOpenCard={setOpenCardId}
                    />
                ) : (
                    <>
                        {commentPanelOpen && (
                            <CommentPanel
                                cards={cards}
                                entries={allComments}
                                activeCardIds={activeComments.ids}
                                anchorTexts={activeComments.anchorTexts}
                                currentUserEmail={auth.user!.email}
                                filter={commentFilter}
                                members={members}
                                onClose={closePanels}
                                onCommentClick={setOpenCardId}
                                onCommentContextMenu={(e, card, entry) =>
                                    commentContextMenu.handleContextMenu(e, { card, entry })
                                }
                            />
                        )}
                        {activityPanelOpen && (
                            <ActivityPanel path={path} cards={cards} onClose={closePanels} onOpenCard={setOpenCardId} />
                        )}
                    </>
                )}
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
