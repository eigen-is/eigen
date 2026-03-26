import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {EditorContent, useEditor} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import Typography from "@tiptap/extension-typography";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import CharacterCount from "@tiptap/extension-character-count";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import {common, createLowlight} from "lowlight";
import * as Y from "yjs";
import {WebsocketProvider} from "y-websocket";
import {useAuth} from "@workspace/lib/auth";
import {EditorToolbar} from "./editor-toolbar";
import {Column, LoadingState} from "@workspace/ui";
import {DrivePath} from "@workspace/lib/types/drive";
import {getCollabWebSocketUrl} from "@workspace/lib/api";
import {EIGEN_ACCENT_COLORS_SHUFFLED} from "@workspace/lib/constants/colors";
import {MediaResolverProvider, useMediaResolver, useUploadFile} from "@workspace/lib/drive";
import {EIGEN_CLIPBOARD_MIME, needsReUpload, readEigenClipboard, reUploadImage,} from '@workspace/lib/clipboard';
import type {EigenClipboardData, EigenClipboardImageItem} from '@workspace/lib/types/clipboard';
import {CreateCommentDialog, ViewCommentDialog} from "./comment-dialog";
import {CommentMark} from "./extensions/comment-mark";
import {ResizableImage} from "./extensions/resizable-image";

const lowlight = createLowlight(common);
const A4_WIDTH_PX = 794; // 210mm at 96dpi

export const CollaborativeEditor = ({path, access, mediaFolderId, chatFolderId, onAccessDialogOpen, onDeleteDialogOpen}: {
    path: DrivePath,
    access: { canRead: boolean; canWrite: boolean; },
    mediaFolderId: string | null,
    chatFolderId: string | null,
    onAccessDialogOpen: () => void,
    onDeleteDialogOpen: (open: boolean) => void
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
        yProvider.on("sync", setConnected);
        setProvider(yProvider);

        return () => {
            yProvider?.off("sync", setConnected);
            yProvider?.destroy();
        };
    }, [yDoc, path.ownerId, path.mountId, path.id]);

    if (!connected || !provider) {
        return <LoadingState/>;
    }

    return (
        <MediaResolverProvider ownerId={path.ownerId} mountId={path.mountId} mediaFolderId={mediaFolderId} chatFolderId={chatFolderId}>
            <TiptapEditor
                path={path}
                yDoc={yDoc}
                provider={provider}
                access={access}
                mediaFolderId={mediaFolderId}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={onAccessDialogOpen}
                onDeleteDialogOpen={onDeleteDialogOpen}
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
                          onDeleteDialogOpen,
                      }: {
    yDoc: Y.Doc;
    provider: WebsocketProvider;
    path: DrivePath;
    access: { canRead: boolean, canWrite: boolean };
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    onDeleteDialogOpen: (open: boolean) => void;
}) => {
    const auth = useAuth();
    const uploadFile = useUploadFile(path.ownerId, path.mountId);
    const {resolveMediaPath} = useMediaResolver();
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

    const editor = useEditor({
        editable: access.canWrite,
        extensions: [
            StarterKit.configure({
                history: false,
                codeBlock: false,
                dropcursor: {
                    color: 'var(--color-primary)',
                    width: 2,
                },
            }),
            Underline,
            Subscript,
            Superscript,
            Typography,
            TextStyle,
            Color,
            FontFamily,
            CharacterCount,
            TextAlign.configure({
                types: ['heading', 'paragraph'],
            }),
            TaskList,
            TaskItem.configure({
                nested: true,
            }),
            Link.configure({
                openOnClick: true,
                HTMLAttributes: {
                    class: 'text-blue-600 underline cursor-pointer',
                    target: '_blank',
                    rel: 'noopener noreferrer',
                },
                validate: (href) => /^(https?:|mailto:|tel:|\/)/i.test(href),
            }),
            ResizableImage,
            Highlight.configure({
                multicolor: true,
            }),
            CodeBlockLowlight.configure({
                lowlight,
            }),
            Table.configure({
                resizable: true,
            }),
            TableRow,
            TableCell,
            TableHeader,
            CommentMark.configure({
                onCommentClick: handleCommentClick,
            }),
            Collaboration.configure({
                document: yDoc,
            }),
            CollaborationCursor.configure({
                provider,
                user: {
                    name: auth.user!.name,
                    color: EIGEN_ACCENT_COLORS_SHUFFLED[Math.abs([...auth.user!.id].reduce((h, c) => (h << 5) - h + c.charCodeAt(0), 0)) % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
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
                    'Georgia': "'Source Serif 4', serif",
                    'Palatino': "'Source Serif 4', serif",
                    'Palatino Linotype': "'Source Serif 4', serif",
                    'Courier New': "'JetBrains Mono', monospace",
                    'Consolas': "'JetBrains Mono', monospace",
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
                const imageFile = files.find(f => f.type.startsWith('image/'));
                if (imageFile && mediaFolderIdRef.current) {
                    event.preventDefault();
                    handleImageUpload(imageFile);
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
                        handleEigenImagePaste(imageItem, width);
                        return true;
                    }
                }

                const files = Array.from(event.clipboardData.files);
                const imageFile = files.find(f => f.type.startsWith('image/'));
                if (imageFile && mediaFolderIdRef.current) {
                    event.preventDefault();
                    handleImageUpload(imageFile);
                    return true;
                }
                return false;
            },
        },
    }, [handleCommentClick]);

    editorRef.current = editor;

    const handleImageUpload = async (file: File) => {
        if (!mediaFolderIdRef.current || !file.type.startsWith('image/')) return;
        const mediaFolderId = mediaFolderIdRef.current;

        const result = await uploadFile.mutateAsync({parentId: mediaFolderId, file});
        if (result && editorRef.current) {
            editorRef.current.chain().focus().setResizableImage({mediaName: result.name}).run();
        }
    };

    const handleEigenImagePaste = async (item: EigenClipboardImageItem, width?: number) => {
        const currentMediaFolderId = mediaFolderIdRef.current;
        if (needsReUpload(item.sourceParentId, currentMediaFolderId) && currentMediaFolderId) {
            const result = await reUploadImage(
                item.sourcePathId, item.sourceOwnerId, item.sourceMountId,
                currentMediaFolderId, uploadFile.mutateAsync, path.ownerId, path.mountId, item.mediaName,
            );
            if (result && editorRef.current) {
                editorRef.current.chain().focus().setResizableImage({mediaName: result.mediaName, width}).run();
                return;
            }
        }
        if (editorRef.current) {
            editorRef.current.chain().focus().setResizableImage({mediaName: item.mediaName, width}).run();
        }
    };

    useEffect(() => {
        if (!editor) return;
        const handleCopy = (e: ClipboardEvent) => {
            if (!editor.isFocused) return;
            const {from, to} = editor.state.selection;
            if (from === to) return;

            const items: EigenClipboardData['items'] = [];
            editor.state.doc.nodesBetween(from, to, (node) => {
                if (node.type.name === 'resizableImage' && node.attrs.mediaName) {
                    const mediaPath = resolveMediaPath(node.attrs.mediaName);
                    if (mediaPath) {
                        const width = node.attrs.width ?? undefined;
                        items.push({
                            type: 'image',
                            mediaName: node.attrs.mediaName,
                            sourcePathId: mediaPath.id,
                            sourceParentId: mediaPath.parentId,
                            sourceOwnerId: mediaPath.ownerId,
                            sourceMountId: mediaPath.mountId,
                            meta: {width},
                        });
                    }
                }
            });

            const text = editor.state.doc.textBetween(from, to, '\n');
            if (text.trim()) {
                items.push({type: 'text', text: text.trim()});
            }

            if (items.length > 0) {
                const data: EigenClipboardData = {version: 1, items};
                e.clipboardData?.setData(EIGEN_CLIPBOARD_MIME, JSON.stringify(data));
            }
        };
        document.addEventListener('copy', handleCopy);
        return () => document.removeEventListener('copy', handleCopy);
    }, [editor, resolveMediaPath]);

    const handleAddComment = () => {
        if (!editor || !chatFolderId) return;
        const {from, to} = editor.state.selection;
        const text = editor.state.doc.textBetween(from, to, ' ');
        if (!text.trim()) return;
        setCommentSelectedText(text);
        setCommentDialogOpen(true);
    };

    const handleCommentCreated = (chatName: string) => {
        if (!editor) return;
        editor.chain().focus().setComment(chatName).run();
    };

    if (!editor) return null;

    return (
        <>
            <Column id={"doc-editor"} width={"w-full"} toolbar={
                <EditorToolbar
                    editor={editor}
                    path={path}
                    canWrite={access.canWrite}
                    onDeleteDialogOpen={onDeleteDialogOpen}
                    onAccessDialogOpen={onAccessDialogOpen}
                    onAddComment={chatFolderId ? handleAddComment : undefined}
                    onImageUpload={mediaFolderId ? handleImageUpload : undefined}
                />}>
                <div ref={scrollContainerRef}
                     className={`h-full w-full overflow-y-scroll bg-muted p-4 ${needsScale ? 'overflow-x-hidden' : ''}`}>
                    <div
                        data-document="true"
                        className={`grid p-[2cm] bg-white text-black rounded-lg shadow-sm shadow-transparent w-[210mm] print:shadow-none ${needsScale ? '' : 'min-h-full m-auto'}`}
                        ref={documentRef}
                        style={needsScale ? {
                            transform: `scale(${canvasScale})`,
                            transformOrigin: 'top left',
                            marginBottom: -(1 - canvasScale) * docHeight,
                        } : undefined}
                    >
                        <EditorContent editor={editor} className="h-full tiptap-wrapper"/>
                    </div>
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
                    onOpenChange={(open) => { if (!open) setViewCommentChatName(null); }}
                    ownerId={path.ownerId}
                    mountId={path.mountId}
                    chatName={viewCommentChatName}
                />
            )}
        </>
    );
};
