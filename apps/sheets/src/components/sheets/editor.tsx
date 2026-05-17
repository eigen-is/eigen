import { getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useComments, useResolveComment } from '@workspace/lib/chat';
import {
    useCardIdFromChatName,
    useCommentCards,
    useCreateCommentCard,
    useOpenCommentCard,
    useUnresolvedCommentCount,
    useUpdateCommentCard,
} from '@workspace/lib/comments';
import { EIGEN_STICKIES_INDICATOR_MAP } from '@workspace/lib/constants/colors';
import { isPendingMediaName, useCopyToMediaFolder, useMediaResolver } from '@workspace/lib/drive';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Workbook, type WorkbookInstance } from '@workspace/sheet';
import { AddCardDialog, CardDialog, CommentContextMenu, CommentPanel, LoadingState } from '@workspace/ui';
import { useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { DrivePickerWithUpload } from '@workspace/ui/components/layout/drive/drive-picker-with-upload';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { columnToLetter, useActiveComments } from './hooks/use-active-comments';
import { useSheet } from './hooks/use-sheet';
import { ToolbarLeftItems, ToolbarRightItems } from './toolbar';

type SheetEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
};

export function SheetEditor({
    ownerId,
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
}: SheetEditorProps) {
    const workbookRef = useRef<WorkbookInstance>(null);
    const [imagePickerOpen, setImagePickerOpen] = useState(false);

    const { initialData, snapshotVersion, synced, handleOp, onDataChange, handleRestore, docRef } = useSheet(
        ownerId,
        path.mountId,
        path.id,
        workbookRef,
    );

    const auth = useAuth();
    const copyToMediaFolder = useCopyToMediaFolder(ownerId, path.mountId);
    const { resolveMediaUrl, startUpload } = useMediaResolver();
    const [commentPanelOpen, setCommentPanelOpen] = useState(false);
    const [addOpen, setAddOpen] = useState(false);
    const [addInitialTitle, setAddInitialTitle] = useState('');
    const [addTargetCell, setAddTargetCell] = useState<{ r: number; c: number } | null>(null);
    const [openCardId, setOpenCardId] = useState<string | null>(null);
    const [flowdata, setFlowdata] = useState<(import('@workspace/sheet').Cell | null)[][] | undefined>();
    const activeComments = useActiveComments(flowdata);
    const { data: allComments = [] } = useComments(ownerId, path.mountId, path.id);
    const resolveComment = useResolveComment(ownerId, path.mountId, path.id);
    const cards = useCommentCards(docRef.current, 'comments');
    const createCard = useCreateCommentCard(ownerId, path.mountId, chatFolderId, docRef.current, 'comments');
    const updateCard = useUpdateCommentCard(docRef.current, 'comments');
    const commentContextMenu = useContextMenu<{ card: CommentCard; entry: CommentEntry | undefined }>();

    const unresolvedCount = useUnresolvedCommentCount(cards, allComments, activeComments.ids);
    const { card: openCard, entry: openEntry } = useOpenCommentCard(cards, allComments, openCardId);
    useCardIdFromChatName(cards, initialChatName, setOpenCardId);

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
        async ({ title, description, color }: { title: string; description: string; color?: string }) => {
            if (!addTargetCell || !workbookRef.current) return;
            const cell = addTargetCell;
            await createCard({ title, description, color }, (card) => {
                const fd = workbookRef.current?.getFlowdata();
                const existing = fd?.[cell.r]?.[cell.c]?.commentCardIds ?? [];
                workbookRef.current?.setCellFormat(cell.r, cell.c, 'commentCardIds', [...existing, card.id]);
            });
            setAddTargetCell(null);
            setAddOpen(false);
        },
        [addTargetCell, createCard],
    );

    const leftItems = useMemo(
        () => (
            <ToolbarLeftItems
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onRestore={handleRestore}
            />
        ),
        [path, canWrite, onAccessDialogOpen, handleRestore],
    );

    const rightItems = useMemo(
        () => (
            <ToolbarRightItems
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onToggleCommentPanel={() => setCommentPanelOpen((v) => !v)}
                commentPanelOpen={commentPanelOpen}
                unresolvedCommentCount={unresolvedCount}
            />
        ),
        [canWrite, onAccessDialogOpen, commentPanelOpen, unresolvedCount],
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
                <div className="flex-1 overflow-hidden">
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
                        column={26}
                        row={100}
                        hooks={{
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
                                      onCommentResolve: (chatName: string) =>
                                          resolveComment.mutate({ chatName, status: 'resolved' }),
                                      onCommentReopen: (chatName: string) =>
                                          resolveComment.mutate({ chatName, status: 'open' }),
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
                {commentPanelOpen && (
                    <CommentPanel
                        cards={cards}
                        entries={allComments}
                        activeCardIds={activeComments.ids}
                        anchorTexts={activeComments.anchorTexts}
                        currentUserEmail={auth.user!.email}
                        onClose={() => setCommentPanelOpen(false)}
                        onCommentClick={(cardId) => setOpenCardId(cardId)}
                        onCommentContextMenu={(e, card, entry) =>
                            commentContextMenu.handleContextMenu(e, { card, entry })
                        }
                    />
                )}
            </div>

            <AddCardDialog
                open={addOpen}
                onOpenChange={(o) => {
                    setAddOpen(o);
                    if (!o) setAddTargetCell(null);
                }}
                initialTitle={addInitialTitle}
                onSave={handleSaveNew}
                titleLabel="New comment"
                submitLabel="Add comment"
            />

            <CardDialog
                open={!!openCard}
                onOpenChange={(o) => {
                    if (!o) setOpenCardId(null);
                }}
                card={openCard}
                entry={openEntry}
                ownerId={ownerId}
                mountId={path.mountId}
                canWrite={canWrite}
                copyLinkUrl={
                    openCard?.chatName
                        ? `${getDriveItemUrl(path)}?chat=${encodeURIComponent(openCard.chatName)}`
                        : undefined
                }
                showResolveAction
                onUpdate={(patch) => openCard && updateCard(openCard.id, patch)}
                onResolve={(chatName, next) => resolveComment.mutate({ chatName, status: next })}
            />

            <CommentContextMenu
                contextMenu={commentContextMenu}
                onOpen={setOpenCardId}
                onUpdateCard={updateCard}
                onResolve={(chatName, status) => resolveComment.mutate({ chatName, status })}
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
