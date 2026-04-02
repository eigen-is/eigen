import { Workbook, type WorkbookInstance } from '@workspace/fortune-sheet';
import { useAuth } from '@workspace/lib/auth';
import { useComments, useResolveComment, useUpdateCommentColor } from '@workspace/lib/chat';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants/colors';
import { MediaResolverProvider } from '@workspace/lib/drive';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    CommentPanel,
    CommentThread,
    CreateCommentDialog,
    LoadingState,
    NoteCardContextMenu,
    NoteCardDialog,
} from '@workspace/ui';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useActiveComments } from './hooks/use-active-comments';
import { useSheet } from './hooks/use-sheet';
import { ToolbarLeftItems, ToolbarRightItems } from './toolbar';

type SheetEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
};

const TOOLBAR_ITEMS = [
    'undo',
    'redo',
    'format-painter',
    'clear-format',
    '|',
    'font',
    '|',
    'font-size',
    '|',
    'format',
    '|',
    'bold',
    'italic',
    'strike-through',
    'underline',
    '|',
    'font-color',
    'background',
    'border',
    'merge-cell',
    '|',
    'horizontal-align',
    'vertical-align',
    'text-wrap',
    '|',
    'freeze',
    'conditionFormat',
    'filter',
    'quick-formula',
    'search',
];

export function SheetEditor({ ownerId, path, canWrite, chatFolderId, onAccessDialogOpen }: SheetEditorProps) {
    const workbookRef = useRef<WorkbookInstance>(null);

    const { initialData, synced, handleOp, onDataChange, handleRestore } = useSheet(
        ownerId,
        path.mountId,
        path.id,
        workbookRef,
    );

    const auth = useAuth();
    const [commentPanelOpen, setCommentPanelOpen] = useState(false);
    const [commentDialogOpen, setCommentDialogOpen] = useState(false);
    const [commentSelectedText, setCommentSelectedText] = useState('');
    const [commentCellRef, setCommentCellRef] = useState<{ r: number; c: number } | null>(null);
    const [viewCommentChatName, setViewCommentChatName] = useState<string | null>(null);

    const flowdata = workbookRef.current?.getFlowdata() ?? undefined;
    const activeComments = useActiveComments(flowdata);
    const { data: allComments = [] } = useComments(ownerId, path.mountId, path.id);
    const resolveComment = useResolveComment(ownerId, path.mountId, path.id);
    const updateColor = useUpdateCommentColor(ownerId, path.mountId, path.id);
    const commentContextMenu = useContextMenu<CommentEntry>();

    const unresolvedCount = useMemo(() => {
        return allComments.filter((c) => c.status === 'open' && activeComments.ids.has(c.chatName)).length;
    }, [allComments, activeComments.ids]);

    const viewCommentEntry = viewCommentChatName ? allComments.find((c) => c.chatName === viewCommentChatName) : null;

    const addCommentRef = useRef<(r: number, c: number) => void>(null);
    addCommentRef.current = useCallback((r: number, c: number) => {
        setCommentCellRef({ r, c });
        const colLetter = String.fromCharCode(65 + (c % 26));
        setCommentSelectedText(`Cell ${colLetter}${r + 1}`);
        setCommentDialogOpen(true);
    }, []);

    const handleCommentCreated = useCallback(
        (chatName: string) => {
            if (!commentCellRef || !workbookRef.current) return;
            workbookRef.current.setCellFormat(commentCellRef.r, commentCellRef.c, 'commentChatNames', [chatName]);
            updateColor.mutate({ chatName, color: EIGEN_STICKIES_COLORS[0][1].value });
            setCommentCellRef(null);
        },
        [commentCellRef, updateColor],
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
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onRestore={handleRestore}
                onToggleCommentPanel={() => setCommentPanelOpen((v) => !v)}
                commentPanelOpen={commentPanelOpen}
                unresolvedCommentCount={unresolvedCount}
            />
        ),
        [path, canWrite, onAccessDialogOpen, handleRestore, commentPanelOpen, unresolvedCount],
    );

    if (!synced || !initialData) {
        return <LoadingState />;
    }

    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={null}
            chatFolderId={chatFolderId}
        >
            <div className="flex flex-col h-full w-full">
                <div className="flex-1 flex overflow-hidden">
                    <div className="flex-1 overflow-hidden">
                        <Workbook
                            ref={workbookRef}
                            data={initialData}
                            onChange={onDataChange}
                            onOp={handleOp}
                            showToolbar={true}
                            showFormulaBar={true}
                            showSheetTabs={true}
                            allowEdit={canWrite}
                            toolbarItems={TOOLBAR_ITEMS}
                            toolbarLeftItems={leftItems}
                            toolbarRightItems={rightItems}
                            defaultRowHeight={25}
                            defaultFontSize={11}
                            column={26}
                            row={100}
                        />
                    </div>
                    {commentPanelOpen && (
                        <CommentPanel
                            ownerId={ownerId}
                            mountId={path.mountId}
                            containerId={path.id}
                            currentUserEmail={auth.user!.email}
                            activeCommentIds={activeComments.ids}
                            anchorTexts={activeComments.anchorTexts}
                            onClose={() => setCommentPanelOpen(false)}
                            onCommentClick={(chatName) => setViewCommentChatName(chatName)}
                            onCommentContextMenu={commentContextMenu.handleContextMenu}
                        />
                    )}
                </div>
            </div>

            {chatFolderId && (
                <CreateCommentDialog
                    open={commentDialogOpen}
                    onOpenChange={setCommentDialogOpen}
                    ownerId={ownerId}
                    mountId={path.mountId}
                    chatFolderId={chatFolderId}
                    selectedText={commentSelectedText}
                    onCommentCreated={handleCommentCreated}
                />
            )}

            {viewCommentChatName && viewCommentEntry && (
                <NoteCardDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setViewCommentChatName(null);
                    }}
                    title={activeComments.anchorTexts.get(viewCommentChatName) || viewCommentChatName}
                    description={
                        viewCommentEntry.lastAuthorEmail
                            ? `Comment by ${viewCommentEntry.lastAuthorEmail.split('@')[0]}`
                            : undefined
                    }
                >
                    <CommentThread ownerId={ownerId} mountId={path.mountId} chatName={viewCommentChatName} />
                </NoteCardDialog>
            )}

            <ContextMenuAnchor contextMenu={commentContextMenu}>
                <NoteCardContextMenu
                    currentColor={commentContextMenu.item?.color}
                    status={commentContextMenu.item?.status}
                    onEdit={() => {
                        if (commentContextMenu.item) setViewCommentChatName(commentContextMenu.item.chatName);
                        commentContextMenu.close();
                    }}
                    onChangeColor={(color) => {
                        if (commentContextMenu.item)
                            updateColor.mutate({ chatName: commentContextMenu.item.chatName, color: color || null });
                        commentContextMenu.close();
                    }}
                    onResolve={() => {
                        if (commentContextMenu.item)
                            resolveComment.mutate({ chatName: commentContextMenu.item.chatName, status: 'resolved' });
                        commentContextMenu.close();
                    }}
                    onReopen={() => {
                        if (commentContextMenu.item)
                            resolveComment.mutate({ chatName: commentContextMenu.item.chatName, status: 'open' });
                        commentContextMenu.close();
                    }}
                    onDelete={() => {
                        if (!commentContextMenu.item || !workbookRef.current) {
                            commentContextMenu.close();
                            return;
                        }
                        const chatName = commentContextMenu.item.chatName;
                        const fd = workbookRef.current.getFlowdata();
                        if (fd) {
                            for (let r = 0; r < fd.length; r++) {
                                const row = fd[r];
                                if (!row) continue;
                                for (let c = 0; c < row.length; c++) {
                                    const cell = row[c];
                                    if (cell?.commentChatNames?.includes(chatName)) {
                                        workbookRef.current!.setCellFormat(
                                            r,
                                            c,
                                            'commentChatNames',
                                            cell.commentChatNames.filter((n: string) => n !== chatName),
                                        );
                                    }
                                }
                            }
                        }
                        commentContextMenu.close();
                    }}
                />
            </ContextMenuAnchor>
        </MediaResolverProvider>
    );
}
