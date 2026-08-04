import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import type { Node } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { needsReUpload, readEigenClipboard, reUploadImage, writeEigenClipboard } from '@workspace/lib/clipboard';
import {
    findCardIdByChatName,
    useCommentFilter,
    useCommentLifecycle,
    useDocumentPanels,
} from '@workspace/lib/comments';
import { userColor } from '@workspace/lib/constants/colors';
import { A4_WIDTH_PX, getDocExtensions, PAGE_MARGIN_PX } from '@workspace/lib/docs/eigendoc';
import {
    isPendingMediaName,
    MediaResolverProvider,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
} from '@workspace/lib/drive';
import { useDocCommentSearchHalf } from '@workspace/lib/search';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { EigenClipboardData, EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { ActiveComments, CardAttachmentDraft, CommentCard } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    ActivityPanel,
    CardFormDialog,
    Column,
    CommentLifecycleDialogs,
    CommentMenuItems,
    CommentPanel,
    LoadingState,
    MobilePanelColumn,
    useLayout,
} from '@workspace/ui';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { renderPresenceCaret } from '@workspace/ui/components/layout/collab';
import type { CommentContextMenuItem } from '@workspace/ui/components/layout/comments';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { PROPERTIES_PANEL_WIDTH_PX } from '@workspace/ui/components/layout/properties-panel';
import { DocSearchProvider } from '@workspace/ui/components/layout/search/doc-search-provider';
import { useProseMirrorSearchController } from '@workspace/ui/components/layout/search/prosemirror-search-controller';
import { SearchHighlight } from '@workspace/ui/components/layout/search/prosemirror-search-highlight';
import { cn } from '@workspace/ui/lib/utils';
import { common, createLowlight } from 'lowlight';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

// The panel is an absolute overlay, so it covers all of the scroll box's content box but its p-4 gutter.
const PANEL_INTRUSION_PX = PROPERTIES_PANEL_WIDTH_PX - 16;
// Only the text column has to stay clear of the panel; the page's right margin may tuck under it.
const TEXT_COLUMN_RIGHT_PX = A4_WIDTH_PX - PAGE_MARGIN_PX;
// Above this the panel clears the centred page outright: every value below is pinned, so stop storing width.
const PANEL_CLEAR_WIDTH_PX = 2 * (TEXT_COLUMN_RIGHT_PX + PANEL_INTRUSION_PX) - A4_WIDTH_PX;

export const CollaborativeEditor = ({
    path,
    access,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
    initialSearchTerm,
}: {
    path: DrivePath;
    access: { canRead: boolean; canWrite: boolean };
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
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
                initialSearchTerm={initialSearchTerm}
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
    initialSearchTerm,
}: {
    yDoc: Y.Doc;
    provider: WebsocketProvider;
    path: DrivePath;
    access: { canRead: boolean; canWrite: boolean };
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
}) => {
    const auth = useAuth();
    const uploadFile = useUploadFile(path.ownerId, path.mountId);
    const copyToMediaFolder = useCopyToMediaFolder(path.ownerId, path.mountId);
    const { resolveMediaPath, startUpload } = useMediaResolver();
    const [addOpen, setAddOpen] = useState(false);
    const [pendingMarkRange, setPendingMarkRange] = useState<{ from: number; to: number; text: string } | null>(null);
    const { isMobile } = useLayout();
    const {
        panel,
        commentPanelOpen,
        activityPanelOpen,
        mobilePanelOpen,
        toggleComments,
        toggleActivity,
        openComments,
        closePanels,
        onSearchOpenChange,
    } = useDocumentPanels(isMobile);
    const [containerWidth, setContainerWidth] = useState(0);
    const [docHeight, setDocHeight] = useState(0);
    const needsScaleRef = useRef(false);
    const documentRef = useRef<HTMLDivElement | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
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

    // Callback refs so each observer dies with its node; a 0×0 write would pin the document at scale(0).
    const setScrollContainer = useCallback((el: HTMLDivElement | null) => {
        scrollContainerRef.current = el;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width === 0) return;
            setContainerWidth(Math.min(entry.contentRect.width, PANEL_CLEAR_WIDTH_PX));
        });
        ro.observe(el);
        return () => {
            scrollContainerRef.current = null;
            ro.disconnect();
        };
    }, []);

    const setDocumentEl = useCallback((el: HTMLDivElement | null) => {
        documentRef.current = el;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            // Only the scaled branch reads docHeight; the effect below seeds it on the way in.
            if (!needsScaleRef.current) return;
            const height = el.offsetHeight;
            if (height === 0) return;
            setDocHeight(height);
        });
        ro.observe(el);
        return () => {
            documentRef.current = null;
            ro.disconnect();
        };
    }, []);

    const handleCommentClick = useCallback(
        (cardId: string) => {
            openComments();
            setOpenCardId(cardId);
        },
        [openComments],
    );

    const editor = useEditor(
        {
            editable: access.canWrite,
            extensions: [
                ...getDocExtensions({ lowlight, exclude: ['figure', 'comment'] }),
                Figure,
                TableWidthClamp,
                SearchHighlight,
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
                    onToggleCommentPanel: toggleComments,
                }),
                Collaboration.configure({
                    document: yDoc,
                }),
                CollaborationCaret.configure({
                    provider,
                    user: {
                        name: auth.user!.name,
                        color: userColor(auth.user!.id),
                    },
                    render: (user: Record<string, string>) =>
                        renderPresenceCaret({ name: user.name, color: user.color }),
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

    const activeComments = useActiveComments(editor);
    const lifecycle = useCommentLifecycle({
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: yDoc,
        activeCardIds: activeComments.ids,
        initialChatName,
    });
    const { allComments, cards, createCard, assignComment, members, unresolvedCount, setOpenCardId } = lifecycle;
    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    allCommentsRef.current = allComments;
    cardsRef.current = cards;

    const commentContextMenu = useContextMenu<CommentContextMenuItem>();
    const selectionContextMenu = useContextMenu<boolean>();

    const handleSaveNew = useCallback(
        async (
            patch: { title?: string; description?: string; color?: string },
            attachments?: CardAttachmentDraft[],
            assignee?: string | null,
        ) => {
            if (!editor || !pendingMarkRange) return;
            const range = pendingMarkRange;
            const card = await createCard(
                { title: pendingMarkRange.text.slice(0, 100), ...patch, attachments },
                (card) => {
                    editor
                        .chain()
                        .focus()
                        .setTextSelection({ from: range.from, to: range.to })
                        .setComment(card.id)
                        .run();
                },
            );
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setPendingMarkRange(null);
            setAddOpen(false);
        },
        [editor, pendingMarkRange, createCard, assignComment],
    );

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

    const docSearchController = useProseMirrorSearchController(editor, access.canWrite);
    const commentSearchHalf = useDocCommentSearchHalf(path.ownerId, path.mountId, path.id);

    const activePanel = panel ?? sidebarContext;
    const showSidebar = !isMobile && (panel !== null || (access.canWrite && sidebarContext !== 'document'));

    // Slide the centred page left by its overlap with the panel; only shrink once the slack runs out.
    const centredSlack = Math.max(0, (containerWidth - A4_WIDTH_PX) / 2);
    const panelLeft = containerWidth - PANEL_INTRUSION_PX;
    const panelOverlap = showSidebar ? Math.max(0, centredSlack + TEXT_COLUMN_RIGHT_PX - panelLeft) : 0;
    const canShift = containerWidth > 0 && panelOverlap <= centredSlack;
    const canvasShift = canShift ? panelOverlap : 0;
    const canvasScale =
        containerWidth === 0
            ? 1
            : Math.min(1, containerWidth / A4_WIDTH_PX, canShift ? 1 : panelLeft / TEXT_COLUMN_RIGHT_PX);
    const needsScale = canvasScale < 1;

    // The document observer stays quiet while unscaled, so seed the height on the way in.
    useLayoutEffect(() => {
        needsScaleRef.current = needsScale;
        if (needsScale && documentRef.current) setDocHeight(documentRef.current.offsetHeight);
    }, [needsScale]);

    if (!editor) return null;

    const handleScrollToComment = (cardId: string) => {
        const positions = findCommentMarkPositions(editor.state.doc, cardId);
        if (positions.length > 0) {
            editor.chain().focus().setTextSelection(positions[0].pos).scrollIntoView().run();
        }
    };

    // Plain object per render; usePaletteDocSearch stabilises it, so reveal sees the current cards.
    const commentSearch: DocCommentSearch = {
        ...commentSearchHalf,
        reveal: (chatName) => {
            const cardId = findCardIdByChatName(cardsRef.current, chatName);
            if (!cardId) return;
            openComments();
            // The mobile pane hides the editor, so scrolling would drive a view nobody can see.
            if (!isMobile) handleScrollToComment(cardId);
            setOpenCardId(cardId);
        },
    };

    return (
        <>
            <div className="flex h-full w-full overflow-hidden">
                {/* Hiding takes the find bar with it: it floats in this wrapper, outside the pane's Column. */}
                <div className={cn('flex-1 min-w-0 h-full', mobilePanelOpen && 'hidden')}>
                    <DocSearchProvider
                        controller={docSearchController}
                        commentSearch={commentSearch}
                        initialSearchTerm={initialSearchTerm}
                        onOpenChange={onSearchOpenChange}
                        // right-68 = panel width + the bar's own gutter.
                        barClassName={cn('top-14', showSidebar && 'right-68')}
                        // No .focus(): focus stays in the bar so the user can keep replacing after ⌘Z.
                        onUndo={() => editor.commands.undo()}
                        onRedo={() => editor.commands.redo()}
                    >
                        <Column
                            id={'doc-editor'}
                            width={'w-full'}
                            toolbarBorder="always"
                            toolbar={
                                <EditorToolbar
                                    editor={editor}
                                    path={path}
                                    canWrite={access.canWrite}
                                    canUndo={canUndo}
                                    canRedo={canRedo}
                                    onAccessDialogOpen={onAccessDialogOpen}
                                    // Always offered: desktop draws the side panel, mobile the Column.
                                    onToggleCommentPanel={toggleComments}
                                    commentPanelOpen={commentPanelOpen}
                                    onToggleActivityPanel={toggleActivity}
                                    activityPanelOpen={activityPanelOpen}
                                    unresolvedCommentCount={unresolvedCount}
                                    onImageUpload={mediaFolderId ? handleImageUpload : undefined}
                                    onImagePickFromDrive={mediaFolderId ? handleImagePickFromDrive : undefined}
                                    onAddComment={chatFolderId ? handleAddComment : undefined}
                                />
                            }
                        >
                            <div className="h-full relative overflow-hidden">
                                <div
                                    ref={setScrollContainer}
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
                                        ref={setDocumentEl}
                                        style={
                                            needsScale
                                                ? {
                                                      transform: `scale(${canvasScale})`,
                                                      transformOrigin: 'top left',
                                                      marginBottom: -(1 - canvasScale) * docHeight,
                                                  }
                                                : canvasShift > 0
                                                  ? { transform: `translateX(${-canvasShift}px)` }
                                                  : undefined
                                        }
                                    >
                                        <EditorContent editor={editor} className="h-full min-w-0 tiptap-wrapper" />
                                    </div>
                                </div>
                                {!isMobile && (
                                    <div
                                        className={cn(
                                            'absolute inset-y-0 right-0 transition-transform duration-200 ease-in-out',
                                            showSidebar ? 'translate-x-0' : 'translate-x-full',
                                        )}
                                    >
                                        {/* Unmounted when closed: the properties panels key-remount per caret move. */}
                                        {showSidebar &&
                                            (activePanel === 'comments' ? (
                                                <CommentPanel
                                                    cards={cards}
                                                    entries={allComments}
                                                    activeCardIds={activeComments.ids}
                                                    anchorTexts={activeComments.anchorTexts}
                                                    currentUserEmail={auth.user!.email}
                                                    filter={commentFilter}
                                                    members={members}
                                                    onClose={closePanels}
                                                    onCommentClick={(cardId) => {
                                                        handleScrollToComment(cardId);
                                                        setOpenCardId(cardId);
                                                    }}
                                                    onCommentContextMenu={(e, card, entry) => {
                                                        commentContextMenu.handleContextMenu(e, { card, entry });
                                                    }}
                                                />
                                            ) : activePanel === 'activity' ? (
                                                <ActivityPanel
                                                    path={path}
                                                    cards={cards}
                                                    onClose={closePanels}
                                                    onOpenCard={(cardId) => {
                                                        openComments();
                                                        handleScrollToComment(cardId);
                                                        setOpenCardId(cardId);
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
                                            ))}
                                    </div>
                                )}
                            </div>
                        </Column>
                    </DocSearchProvider>
                </div>

                {mobilePanelOpen && panel && (
                    <MobilePanelColumn
                        activePanel={panel}
                        onBack={closePanels}
                        path={path}
                        cards={cards}
                        entries={allComments}
                        members={members}
                        currentUserEmail={auth.user!.email}
                        filter={commentFilter}
                        activeComments={activeComments}
                        commentContextMenu={commentContextMenu}
                        // Not the desktop reveal: the editor is hidden here, so it would scroll unseen.
                        onOpenCard={setOpenCardId}
                    />
                )}
            </div>

            <CardFormDialog
                open={addOpen}
                onOpenChange={(o) => {
                    setAddOpen(o);
                    if (!o) setPendingMarkRange(null);
                }}
                initialTitle={pendingMarkRange ? pendingMarkRange.text.slice(0, 100) : ''}
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
                canWrite={access.canWrite}
                commentContextMenu={commentContextMenu}
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
