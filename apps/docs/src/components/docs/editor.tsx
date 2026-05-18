import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import type { Node } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { getCollabWebSocketUrl, getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useComments, useResolveComment } from '@workspace/lib/chat';
import { needsReUpload, readEigenClipboard, reUploadImage, writeEigenClipboard } from '@workspace/lib/clipboard';
import {
    useCardIdFromChatName,
    useCommentCards,
    useCreateCommentCard,
    useOpenCommentCard,
    useUnresolvedCommentCount,
    useUpdateCommentCard,
} from '@workspace/lib/comments';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import { A4_WIDTH_PX, getDocExtensions } from '@workspace/lib/docs/eigendoc';
import {
    isPendingMediaName,
    MediaResolverProvider,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
} from '@workspace/lib/drive';
import { useMediaQuery } from '@workspace/lib/media';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { EigenClipboardData, EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { ActiveComments, CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    AddCardDialog,
    CardDialog,
    Column,
    CommentContextMenu,
    CommentMenuItems,
    CommentPanel,
    LoadingState,
} from '@workspace/ui';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { cn } from '@workspace/ui/lib/utils';
import { common, createLowlight } from 'lowlight';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { EditorToolbar } from './editor-toolbar';
import { CommentMark, updateCommentDecorations } from './extensions/comment-mark';
import { Figure } from './extensions/figure';
import { TableWidthClamp } from './extensions/table-width-clamp';
import { FigurePropertiesPanel } from './figure-properties-panel';
import { TablePropertiesPanel } from './table-properties-panel';

function findCommentMarkPositions(doc: Node, cardId: string): { pos: number; end: number }[] {
    const positions: { pos: number; end: number }[] = [];
    doc.descendants((node, pos) => {
        for (const mark of node.marks) {
            if (mark.type.name === 'comment' && mark.attrs.cardId === cardId) {
                positions.push({ pos, end: pos + node.nodeSize });
            }
        }
    });
    return positions;
}

function swapFigureMediaName(editor: Editor, pendingName: string, newName: string | null) {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'figure' && node.attrs.mediaName === pendingName) {
            positions.push(pos);
        }
        return true;
    });
    if (positions.length === 0) return;
    editor.commands.command(({ tr, dispatch }) => {
        // Iterate in reverse so earlier positions stay valid after later deletes
        for (let i = positions.length - 1; i >= 0; i--) {
            const pos = positions[i];
            const node = tr.doc.nodeAt(pos);
            if (!node) continue;
            if (newName === null) {
                tr.delete(pos, pos + node.nodeSize);
            } else {
                tr.setNodeAttribute(pos, 'mediaName', newName);
            }
        }
        if (dispatch) dispatch(tr);
        return true;
    });
}

const lowlight = createLowlight(common);

export const CollaborativeEditor = ({
    path,
    access,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
}: {
    path: DrivePath;
    access: { canRead: boolean; canWrite: boolean };
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
}) => {
    const [connected, setConnected] = useState(false);
    const [provider, setProvider] = useState<WebsocketProvider>();

    const yDoc = useMemo(() => new Y.Doc(), []);

    useEffect(() => {
        const wsUrl = getCollabWebSocketUrl(path.ownerId, path.mountId, path.id);

        const yProvider = new WebsocketProvider(wsUrl, '', yDoc, {
            resyncInterval: 5000,
            connect: true,
        });
        yProvider.on('sync', setConnected);
        setProvider(yProvider);

        return () => {
            yProvider?.off('sync', setConnected);
            yProvider?.destroy();
        };
    }, [yDoc, path.ownerId, path.mountId, path.id]);

    if (!connected || !provider) {
        return <LoadingState />;
    }

    return (
        <MediaResolverProvider
            ownerId={path.ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <TiptapEditor
                path={path}
                yDoc={yDoc}
                provider={provider}
                access={access}
                mediaFolderId={mediaFolderId}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={onAccessDialogOpen}
                initialChatName={initialChatName}
            />
        </MediaResolverProvider>
    );
};

const EMPTY_ACTIVE: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

function useActiveComments(editor: Editor | null): ActiveComments {
    const [result, setResult] = useState<ActiveComments>(EMPTY_ACTIVE);

    useEffect(() => {
        if (!editor) return;
        let timer: ReturnType<typeof setTimeout>;

        const update = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const ids = new Set<string>();
                const texts = new Map<string, string>();

                editor.state.doc.descendants((node, pos) => {
                    for (const mark of node.marks) {
                        if (mark.type.name === 'comment' && mark.attrs.cardId) {
                            const cardId = mark.attrs.cardId as string;
                            ids.add(cardId);
                            if (!texts.has(cardId)) {
                                texts.set(
                                    cardId,
                                    editor.state.doc.textBetween(pos, pos + node.nodeSize, ' ').slice(0, 100),
                                );
                            }
                        }
                    }
                });

                setResult({ ids, anchorTexts: texts });
            }, 200);
        };

        update();
        editor.on('update', update);
        return () => {
            editor.off('update', update);
            clearTimeout(timer);
        };
    }, [editor]);

    return result;
}

const TiptapEditor = ({
    yDoc,
    provider,
    path,
    access,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
}: {
    yDoc: Y.Doc;
    provider: WebsocketProvider;
    path: DrivePath;
    access: { canRead: boolean; canWrite: boolean };
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
}) => {
    const auth = useAuth();
    const uploadFile = useUploadFile(path.ownerId, path.mountId);
    const copyToMediaFolder = useCopyToMediaFolder(path.ownerId, path.mountId);
    const { resolveMediaPath, startUpload } = useMediaResolver();
    const [addOpen, setAddOpen] = useState(false);
    const [pendingMarkRange, setPendingMarkRange] = useState<{ from: number; to: number; text: string } | null>(null);
    const [openCardId, setOpenCardId] = useState<string | null>(null);
    const [canvasScale, setCanvasScale] = useState(1);
    const [docHeight, setDocHeight] = useState(0);
    const needsScale = canvasScale < 1;
    const documentRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<ReturnType<typeof useEditor>>(null);
    const handleAddCommentRef = useRef<(() => void) | null>(null);
    const allCommentsRef = useRef<CommentEntry[]>([]);
    const cardsRef = useRef<Record<string, CommentCard>>({});
    const mediaFolderIdRef = useRef(mediaFolderId);
    mediaFolderIdRef.current = mediaFolderId;

    const getEditorMaxWidth = useCallback(() => {
        const el = documentRef.current;
        if (!el) return 642;
        const style = getComputedStyle(el);
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    }, []);

    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => {
            setCanvasScale(Math.min(1, entry.contentRect.width / A4_WIDTH_PX));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const el = documentRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setDocHeight(el.offsetHeight));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const handleCommentClick = useCallback((cardId: string) => {
        setOpenCardId(cardId);
        setCommentPanelOpen(true);
    }, []);

    const editor = useEditor(
        {
            editable: access.canWrite,
            extensions: [
                ...getDocExtensions({ lowlight, exclude: ['figure', 'comment'] }),
                Figure,
                TableWidthClamp,
                CommentMark.configure({
                    onCommentClick: handleCommentClick,
                    onCommentContextMenu: (cardId, event) => {
                        const card = cardsRef.current[cardId];
                        if (!card) return;
                        const entry = card.chatName
                            ? allCommentsRef.current.find((c) => c.chatName === card.chatName)
                            : undefined;
                        commentContextMenu.handleContextMenu(event as unknown as React.MouseEvent, { card, entry });
                    },
                    onSelectionContextMenu: (event) => {
                        selectionContextMenu.handleContextMenu(event as unknown as React.MouseEvent, true);
                    },
                    onAddComment: () => handleAddCommentRef.current?.(),
                    onToggleCommentPanel: () => setCommentPanelOpen((v) => !v),
                }),
                Collaboration.configure({
                    document: yDoc,
                }),
                CollaborationCaret.configure({
                    provider,
                    user: {
                        name: auth.user!.name,
                        color: EIGEN_ACCENT_COLORS_SHUFFLED[
                            Math.abs([...auth.user!.id].reduce((h, c) => (h << 5) - h + c.charCodeAt(0), 0)) %
                                EIGEN_ACCENT_COLORS_SHUFFLED.length
                        ].value,
                    },
                    render: (user: Record<string, string>) => {
                        const cursor = document.createElement('span');
                        cursor.classList.add('collaboration-cursor__caret');
                        cursor.setAttribute('style', `border-color: ${user.color}`);

                        const label = document.createElement('div');
                        label.classList.add('collaboration-cursor__label');
                        label.setAttribute('style', `background-color: ${user.color}`);
                        label.insertBefore(document.createTextNode(user.name), null);

                        cursor.insertBefore(document.createTextNode('⁠'), null);
                        cursor.insertBefore(label, null);
                        cursor.insertBefore(document.createTextNode('⁠'), null);

                        return cursor;
                    },
                }),
            ],
            editorProps: {
                attributes: {
                    class: 'eigen-prose',
                },
                transformPastedHTML: (html: string) => {
                    const maxWidth = getEditorMaxWidth();
                    const doc = new DOMParser().parseFromString(html, 'text/html');

                    const fontMap: Record<string, string> = {
                        'Times New Roman': "'Source Serif 4', serif",
                        Georgia: "'Source Serif 4', serif",
                        Palatino: "'Source Serif 4', serif",
                        'Palatino Linotype': "'Source Serif 4', serif",
                        'Courier New': "'JetBrains Mono', monospace",
                        Consolas: "'JetBrains Mono', monospace",
                        'Comic Sans MS': "'Excalifont', cursive",
                    };
                    doc.querySelectorAll('[style]').forEach((el) => {
                        const htmlEl = el as HTMLElement;
                        const ff = htmlEl.style.fontFamily.replace(/['"]/g, '').trim();
                        const mapped = fontMap[ff];
                        if (mapped) {
                            htmlEl.style.fontFamily = mapped;
                        } else {
                            htmlEl.style.fontFamily = '';
                        }
                    });

                    doc.querySelectorAll('img, table').forEach((el) => {
                        const htmlEl = el as HTMLElement;

                        const attrWidth = el.getAttribute('width');
                        const styleWidth = htmlEl.style.width;
                        let w = 0;
                        if (attrWidth) w = parseInt(attrWidth, 10) || 0;
                        if (!w && styleWidth?.endsWith('px')) w = parseInt(styleWidth, 10) || 0;

                        if (w > maxWidth) {
                            el.setAttribute('width', String(Math.round(maxWidth)));
                            htmlEl.style.width = `${Math.round(maxWidth)}px`;
                        }
                    });

                    return doc.body.innerHTML;
                },
                handleDrop: (view, event) => {
                    if (!event.dataTransfer) return false;
                    const files = Array.from(event.dataTransfer.files);
                    const imageFile = files.find((f) => f.type.startsWith('image/'));
                    if (imageFile && mediaFolderIdRef.current) {
                        event.preventDefault();
                        const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
                        if (dropPos) {
                            const tr = view.state.tr.setSelection(Selection.near(view.state.doc.resolve(dropPos.pos)));
                            view.dispatch(tr);
                        }
                        handleImageUpload(imageFile).catch(() => {});
                        return true;
                    }
                    return false;
                },
                handlePaste: (_view, event) => {
                    if (!event.clipboardData) return false;

                    const eigenData = readEigenClipboard(event.clipboardData);
                    if (eigenData) {
                        const imageItem = eigenData.items.find((i): i is EigenClipboardImageItem => i.type === 'image');
                        if (imageItem) {
                            event.preventDefault();
                            const width = imageItem.meta?.width as number | undefined;
                            handleEigenImagePaste(imageItem, width).catch(() => {});
                            return true;
                        }
                    }

                    const files = Array.from(event.clipboardData.files);
                    const imageFile = files.find((f) => f.type.startsWith('image/'));
                    if (imageFile && mediaFolderIdRef.current) {
                        event.preventDefault();
                        handleImageUpload(imageFile).catch(() => {});
                        return true;
                    }
                    return false;
                },
            },
        },
        [handleCommentClick],
    );

    editorRef.current = editor;

    const { canUndo, canRedo } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            if (!e) return { canUndo: false, canRedo: false };
            const pluginState = yUndoPluginKey.getState(e.state);
            const um = pluginState?.undoManager;
            return {
                canUndo: (um?.undoStack.length ?? 0) > 0,
                canRedo: (um?.redoStack.length ?? 0) > 0,
            };
        },
    });

    const handleImageUpload = async (file: File) => {
        if (!mediaFolderIdRef.current || !file.type.startsWith('image/') || !editorRef.current) return;
        const { pendingName, promise } = startUpload(file);
        editorRef.current.chain().focus().setFigure({ mediaName: pendingName }).run();
        const result = await promise;
        if (editorRef.current) {
            swapFigureMediaName(editorRef.current, pendingName, result?.name ?? null);
        }
    };

    const handleReplaceImage = async (file: File) => {
        if (!mediaFolderIdRef.current || !file.type.startsWith('image/') || !editorRef.current) return;
        const { pendingName, promise } = startUpload(file);
        // Reset width so the new image's aspect ratio is recomputed on load
        editorRef.current.chain().focus().updateAttributes('figure', { mediaName: pendingName, width: null }).run();
        const result = await promise;
        if (!editorRef.current) return;
        swapFigureMediaName(editorRef.current, pendingName, result?.name ?? null);
    };

    const handleImagePickFromDrive = async (paths: DrivePath[]) => {
        if (!mediaFolderIdRef.current || !editorRef.current) return;
        const results = await copyToMediaFolder
            .mutateAsync({ paths, mediaFolderId: mediaFolderIdRef.current })
            .catch(() => null);
        if (!results) return;
        for (const result of results) {
            editorRef.current.chain().focus().setFigure({ mediaName: result.name }).run();
        }
    };

    const handleReplaceImageFromDrive = async (paths: DrivePath[]) => {
        if (!mediaFolderIdRef.current || !editorRef.current || paths.length === 0) return;
        const result = await copyToMediaFolder
            .mutateAsync({ paths: [paths[0]], mediaFolderId: mediaFolderIdRef.current })
            .catch(() => null);
        if (result?.[0]) {
            editorRef.current
                .chain()
                .focus()
                .updateAttributes('figure', { mediaName: result[0].name, width: null })
                .run();
        }
    };

    const handleEigenImagePaste = async (item: EigenClipboardImageItem, width?: number) => {
        const currentMediaFolderId = mediaFolderIdRef.current;
        if (needsReUpload(item.sourceParentId, currentMediaFolderId) && currentMediaFolderId) {
            const result = await reUploadImage(
                item.sourcePathId,
                item.sourceOwnerId,
                item.sourceMountId,
                currentMediaFolderId,
                uploadFile.mutateAsync,
                path.ownerId,
                path.mountId,
                item.mediaName,
            );
            if (result && editorRef.current) {
                editorRef.current
                    .chain()
                    .focus()
                    .setFigure({ mediaName: result.mediaName, width, caption: item.caption })
                    .run();
                return;
            }
        }
        if (editorRef.current) {
            editorRef.current
                .chain()
                .focus()
                .setFigure({ mediaName: item.mediaName, width, caption: item.caption })
                .run();
        }
    };

    useEffect(() => {
        if (!editor) return;
        const handleCopyOrCut = (e: ClipboardEvent) => {
            if (!editor.isFocused) return;
            const { from, to } = editor.state.selection;
            if (from === to) return;

            const items: EigenClipboardData['items'] = [];
            editor.state.doc.nodesBetween(from, to, (node) => {
                if (node.type.name === 'figure' && node.attrs.mediaName) {
                    const mediaPath = resolveMediaPath(node.attrs.mediaName);
                    if (mediaPath) {
                        items.push({
                            type: 'image',
                            mediaName: node.attrs.mediaName,
                            sourcePathId: mediaPath.id,
                            sourceParentId: mediaPath.parentId,
                            sourceOwnerId: mediaPath.ownerId,
                            sourceMountId: mediaPath.mountId,
                            caption: node.attrs.caption || undefined,
                            meta: { width: node.attrs.width ?? undefined },
                        });
                    }
                }
            });

            if (items.length > 0) {
                const text = editor.state.doc.textBetween(from, to, '\n').trim();
                e.preventDefault();
                writeEigenClipboard(e, { version: 1, items }, text || undefined);
            }
        };
        document.addEventListener('copy', handleCopyOrCut);
        document.addEventListener('cut', handleCopyOrCut);
        return () => {
            document.removeEventListener('copy', handleCopyOrCut);
            document.removeEventListener('cut', handleCopyOrCut);
        };
    }, [editor, resolveMediaPath]);

    const handleAddComment = () => {
        if (!editor || !chatFolderId) return;
        const { from, to } = editor.state.selection;
        const text = editor.state.doc.textBetween(from, to, ' ');
        if (!text.trim()) return;
        setPendingMarkRange({ from, to, text });
        setAddOpen(true);
    };
    handleAddCommentRef.current = chatFolderId ? handleAddComment : null;

    const [sidebarContext, setSidebarContext] = useState<'document' | 'figure' | 'table'>('document');
    const lastPanelRef = useRef<'figure' | 'table'>('figure');
    if (sidebarContext !== 'document') lastPanelRef.current = sidebarContext;

    const [commentPanelOpen, setCommentPanelOpen] = useState(false);
    const activeComments = useActiveComments(editor);
    const resolveComment = useResolveComment(path.ownerId, path.mountId, path.id);
    const { data: allComments = [] } = useComments(path.ownerId, path.mountId, path.id);
    allCommentsRef.current = allComments;

    const cards = useCommentCards(yDoc, 'comments');
    cardsRef.current = cards;
    const createCard = useCreateCommentCard(path.ownerId, path.mountId, chatFolderId, yDoc, 'comments');
    const updateCard = useUpdateCommentCard(yDoc, 'comments');

    const commentContextMenu = useContextMenu<{ card: CommentCard; entry: CommentEntry | undefined }>();
    const selectionContextMenu = useContextMenu<boolean>();

    const handleSaveNew = useCallback(
        async ({ title, description, color }: { title: string; description: string; color?: string }) => {
            if (!editor || !pendingMarkRange) return;
            const range = pendingMarkRange;
            await createCard({ title, description, color }, (card) => {
                editor.chain().focus().setTextSelection({ from: range.from, to: range.to }).setComment(card.id).run();
            });
            setPendingMarkRange(null);
            setAddOpen(false);
        },
        [editor, pendingMarkRange, createCard],
    );

    const unresolvedCount = useUnresolvedCommentCount(cards, allComments, activeComments.ids);
    const { card: openCard, entry: openEntry } = useOpenCommentCard(cards, allComments, openCardId);

    // Sync resolved IDs + colors into the ProseMirror decoration plugin
    useEffect(() => {
        if (!editor) return;
        const resolved = new Set<string>();
        const colorMap = new Map<string, string>();
        for (const cardId of activeComments.ids) {
            const card = cards[cardId];
            if (!card) continue;
            if (card.color) colorMap.set(cardId, card.color);
            if (card.chatName) {
                const entry = allComments.find((c) => c.chatName === card.chatName);
                if (entry?.status === 'resolved') resolved.add(cardId);
            }
        }
        updateCommentDecorations(editor, resolved, colorMap);
    }, [editor, cards, allComments, activeComments.ids]);

    useCardIdFromChatName(cards, initialChatName, setOpenCardId);

    useEffect(() => {
        if (!editor) return;
        const onUpdate = () => {
            if (editor.isActive('figure')) setSidebarContext('figure');
            else if (editor.isActive('table')) setSidebarContext('table');
            else setSidebarContext('document');
        };
        editor.on('selectionUpdate', onUpdate);
        return () => {
            editor.off('selectionUpdate', onUpdate);
        };
    }, [editor]);

    // Sweep zombie placeholders left behind by a tab close or reload mid-upload.
    useEffect(() => {
        if (!editor) return;
        const snapshot: string[] = [];
        editor.state.doc.descendants((node) => {
            if (
                node.type.name === 'figure' &&
                typeof node.attrs.mediaName === 'string' &&
                isPendingMediaName(node.attrs.mediaName)
            ) {
                snapshot.push(node.attrs.mediaName);
            }
            return true;
        });
        if (snapshot.length === 0) return;
        const timer = setTimeout(() => {
            for (const pendingName of snapshot) {
                swapFigureMediaName(editor, pendingName, null);
            }
        }, 60_000);
        return () => clearTimeout(timer);
    }, [editor]);

    const isWide = !useMediaQuery('(max-width: 1200px)');

    if (!editor) return null;

    const activePanel = commentPanelOpen ? 'comments' : sidebarContext;
    const showSidebar = isWide && (activePanel === 'comments' || (access.canWrite && activePanel !== 'document'));

    const handleScrollToComment = (cardId: string) => {
        const positions = findCommentMarkPositions(editor.state.doc, cardId);
        if (positions.length > 0) {
            editor.chain().focus().setTextSelection(positions[0].pos).scrollIntoView().run();
        }
    };

    return (
        <>
            <Column
                id={'doc-editor'}
                width={'w-full'}
                toolbar={
                    <EditorToolbar
                        editor={editor}
                        path={path}
                        canWrite={access.canWrite}
                        canUndo={canUndo}
                        canRedo={canRedo}
                        onAccessDialogOpen={onAccessDialogOpen}
                        onToggleCommentPanel={() => setCommentPanelOpen((v) => !v)}
                        commentPanelOpen={commentPanelOpen}
                        unresolvedCommentCount={unresolvedCount}
                        onImageUpload={mediaFolderId ? handleImageUpload : undefined}
                        onImagePickFromDrive={mediaFolderId ? handleImagePickFromDrive : undefined}
                    />
                }
            >
                <div className="h-full relative overflow-hidden">
                    <div
                        ref={scrollContainerRef}
                        className={cn(
                            'h-full w-full overflow-y-scroll bg-muted p-4',
                            needsScale && 'overflow-x-hidden',
                        )}
                        onClick={(e) => {
                            if (e.target === scrollContainerRef.current) {
                                editor.commands.blur();
                            }
                        }}
                    >
                        <div
                            data-document="true"
                            className={cn(
                                'grid p-[2cm] bg-white text-black rounded-lg shadow-sm shadow-transparent w-[210mm] print:shadow-none',
                                !needsScale && 'min-h-full m-auto',
                            )}
                            ref={documentRef}
                            style={
                                needsScale
                                    ? {
                                          transform: `scale(${canvasScale})`,
                                          transformOrigin: 'top left',
                                          marginBottom: -(1 - canvasScale) * docHeight,
                                      }
                                    : undefined
                            }
                        >
                            <EditorContent editor={editor} className="h-full min-w-0 tiptap-wrapper" />
                        </div>
                    </div>
                    {isWide && (
                        <div
                            className={cn(
                                'absolute inset-y-0 right-0 transition-transform duration-200 ease-in-out',
                                showSidebar ? 'translate-x-0' : 'translate-x-full',
                            )}
                        >
                            {activePanel === 'comments' ? (
                                <CommentPanel
                                    cards={cards}
                                    entries={allComments}
                                    activeCardIds={activeComments.ids}
                                    anchorTexts={activeComments.anchorTexts}
                                    currentUserEmail={auth.user!.email}
                                    onClose={() => setCommentPanelOpen(false)}
                                    onCommentClick={(cardId) => {
                                        handleScrollToComment(cardId);
                                        setOpenCardId(cardId);
                                    }}
                                    onCommentContextMenu={(e, card, entry) => {
                                        commentContextMenu.handleContextMenu(e, { card, entry });
                                    }}
                                />
                            ) : lastPanelRef.current === 'figure' ? (
                                <FigurePropertiesPanel
                                    key={editor.state.selection.from}
                                    editor={editor}
                                    onReplaceImage={handleReplaceImage}
                                    onReplaceImageFromDrive={handleReplaceImageFromDrive}
                                />
                            ) : (
                                <TablePropertiesPanel editor={editor} />
                            )}
                        </div>
                    )}
                </div>
            </Column>

            <AddCardDialog
                open={addOpen}
                onOpenChange={(o) => {
                    setAddOpen(o);
                    if (!o) setPendingMarkRange(null);
                }}
                initialTitle={pendingMarkRange ? pendingMarkRange.text.slice(0, 100) : ''}
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
                ownerId={path.ownerId}
                mountId={path.mountId}
                canWrite={access.canWrite}
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
                    if (!editor) return;
                    const { tr } = editor.state;
                    const commentType = editor.state.schema.marks.comment;
                    for (const { pos, end } of findCommentMarkPositions(editor.state.doc, cardId)) {
                        tr.removeMark(pos, end, commentType);
                    }
                    editor.view.dispatch(tr);
                }}
            />

            <ContextMenuAnchor contextMenu={selectionContextMenu}>
                <CommentMenuItems
                    primitives={{
                        Item: DropdownMenuItem,
                        Sub: DropdownMenuSub,
                        SubTrigger: DropdownMenuSubTrigger,
                        SubContent: DropdownMenuSubContent,
                    }}
                    item={null}
                    onAddComment={() => {
                        handleAddCommentRef.current?.();
                        selectionContextMenu.close();
                    }}
                />
            </ContextMenuAnchor>
        </>
    );
};
