import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Selection } from '@tiptap/pm/state';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { needsReUpload, readEigenClipboard, reUploadImage, writeEigenClipboard } from '@workspace/lib/clipboard';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { MediaResolverProvider, useMediaResolver, useUploadFile } from '@workspace/lib/drive';
import { useMediaQuery } from '@workspace/lib/media';
import type { EigenClipboardData, EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Column, LoadingState } from '@workspace/ui';
import { common, createLowlight } from 'lowlight';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { CreateCommentDialog, ViewCommentDialog } from './comment-dialog';
import { EditorToolbar } from './editor-toolbar';
import { CommentMark } from './extensions/comment-mark';
import { Figure } from './extensions/figure';
import { TableWidthClamp } from './extensions/table-width-clamp';
import { FigurePropertiesPanel } from './figure-properties-panel';
import { TablePropertiesPanel } from './table-properties-panel';

const lowlight = createLowlight(common);
const A4_WIDTH_PX = 794; // 210mm at 96dpi

export const CollaborativeEditor = ({
    path,
    access,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
}: {
    path: DrivePath;
    access: { canRead: boolean; canWrite: boolean };
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
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
            />
        </MediaResolverProvider>
    );
};

const TiptapEditor = ({
    yDoc,
    provider,
    path,
    access,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
}: {
    yDoc: Y.Doc;
    provider: WebsocketProvider;
    path: DrivePath;
    access: { canRead: boolean; canWrite: boolean };
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
}) => {
    const auth = useAuth();
    const uploadFile = useUploadFile(path.ownerId, path.mountId);
    const { resolveMediaPath } = useMediaResolver();
    const [commentDialogOpen, setCommentDialogOpen] = useState(false);
    const [commentSelectedText, setCommentSelectedText] = useState('');
    const [viewCommentChatName, setViewCommentChatName] = useState<string | null>(null);
    const [canvasScale, setCanvasScale] = useState(1);
    const [docHeight, setDocHeight] = useState(0);
    const needsScale = canvasScale < 1;
    const documentRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<ReturnType<typeof useEditor>>(null);
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

    const handleCommentClick = useCallback((chatName: string) => {
        setViewCommentChatName(chatName);
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

                        cursor.insertBefore(document.createTextNode('\u2060'), null);
                        cursor.insertBefore(label, null);
                        cursor.insertBefore(document.createTextNode('\u2060'), null);

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
        if (!mediaFolderIdRef.current || !file.type.startsWith('image/')) return;
        const result = await uploadFile.mutateAsync({ parentId: mediaFolderIdRef.current, file });
        if (result && editorRef.current) {
            editorRef.current.chain().focus().setFigure({ mediaName: result.name }).run();
        }
    };

    const handleReplaceImage = async (file: File) => {
        if (!mediaFolderIdRef.current || !file.type.startsWith('image/') || !editorRef.current) return;
        const result = await uploadFile.mutateAsync({ parentId: mediaFolderIdRef.current, file });
        if (result) {
            editorRef.current.chain().focus().updateAttributes('figure', { mediaName: result.name, width: null }).run();
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
        setCommentSelectedText(text);
        setCommentDialogOpen(true);
    };

    const handleCommentCreated = (chatName: string) => {
        if (!editor) return;
        editor.chain().focus().setComment(chatName).run();
    };

    const [sidebarContext, setSidebarContext] = useState<'document' | 'figure' | 'table'>('document');
    const lastPanelRef = useRef<'figure' | 'table'>('figure');
    if (sidebarContext !== 'document') lastPanelRef.current = sidebarContext;

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

    const isWide = !useMediaQuery('(max-width: 1200px)');

    if (!editor) return null;

    const showSidebar = isWide && access.canWrite && sidebarContext !== 'document';

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
                        onAddComment={chatFolderId ? handleAddComment : undefined}
                        onImageUpload={mediaFolderId ? handleImageUpload : undefined}
                    />
                }
            >
                <div className="h-full relative overflow-hidden">
                    <div
                        ref={scrollContainerRef}
                        className={`h-full w-full overflow-y-scroll bg-muted p-4 ${needsScale ? 'overflow-x-hidden' : ''}`}
                        onClick={(e) => {
                            if (e.target === scrollContainerRef.current) {
                                // Move cursor to end (deselects any NodeSelection) then blur
                                editor.chain().focus('end').blur().run();
                            }
                        }}
                    >
                        <div
                            data-document="true"
                            className={`grid p-[2cm] bg-white text-black rounded-lg shadow-sm shadow-transparent w-[210mm] print:shadow-none ${needsScale ? '' : 'min-h-full m-auto'}`}
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
                            <EditorContent editor={editor} className="h-full tiptap-wrapper" />
                        </div>
                    </div>
                    {isWide && access.canWrite && (
                        <div
                            className={`absolute inset-y-0 right-0 transition-transform duration-200 ease-in-out ${showSidebar ? 'translate-x-0' : 'translate-x-full'}`}
                        >
                            {lastPanelRef.current === 'figure' ? (
                                <FigurePropertiesPanel
                                    key={editor.state.selection.from}
                                    editor={editor}
                                    onReplaceImage={handleReplaceImage}
                                />
                            ) : (
                                <TablePropertiesPanel editor={editor} />
                            )}
                        </div>
                    )}
                </div>
            </Column>

            {chatFolderId && (
                <CreateCommentDialog
                    open={commentDialogOpen}
                    onOpenChange={setCommentDialogOpen}
                    ownerId={path.ownerId}
                    mountId={path.mountId}
                    chatFolderId={chatFolderId}
                    selectedText={commentSelectedText}
                    onCommentCreated={handleCommentCreated}
                />
            )}

            {viewCommentChatName && (
                <ViewCommentDialog
                    open={!!viewCommentChatName}
                    onOpenChange={(open) => {
                        if (!open) setViewCommentChatName(null);
                    }}
                    ownerId={path.ownerId}
                    mountId={path.mountId}
                    chatName={viewCommentChatName}
                />
            )}
        </>
    );
};
