import {useEffect, useMemo, useState, useCallback, useRef} from "react";
import {useEditor, EditorContent} from "@tiptap/react";
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
import {EigenLoader} from "@workspace/ui";
import {DrivePath} from "@workspace/lib/types/drive";
import {getCollabWebSocketUrl, getDriveEmbedUrl} from "@workspace/lib/api";
import {useUploadFile} from "@workspace/lib/drive";
import {CreateCommentDialog, ViewCommentDialog} from "./comment-dialog";
import {CommentMark} from "./extensions/comment-mark";
import {ResizableImage} from "./extensions/resizable-image";

const lowlight = createLowlight(common);

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
        return <div className="flex h-full items-center justify-center"><EigenLoader/></div>;
    }

    return (
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
    const [commentDialogOpen, setCommentDialogOpen] = useState(false);
    const [commentSelectedText, setCommentSelectedText] = useState('');
    const [viewCommentChatId, setViewCommentChatId] = useState<string | null>(null);
    const documentRef = useRef<HTMLDivElement>(null);

    const getEditorMaxWidth = useCallback(() => {
        const el = documentRef.current;
        if (!el) return 642;
        const style = getComputedStyle(el);
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    }, []);

    const handleCommentClick = useCallback((chatId: string) => {
        setViewCommentChatId(chatId);
    }, []);

    const editor = useEditor({
        editable: access.canWrite,
        extensions: [
            StarterKit.configure({
                history: false,
                codeBlock: false,
                dropcursor: {
                    color: '#3b82f6',
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
                    color: '#9810fa',
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
            transformPastedHTML: (html: string) => {
                const maxWidth = getEditorMaxWidth();
                const doc = new DOMParser().parseFromString(html, 'text/html');

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
                if (imageFile && mediaFolderId) {
                    event.preventDefault();
                    handleImageUpload(imageFile);
                    return true;
                }
                return false;
            },
            handlePaste: (_view, event) => {
                if (!event.clipboardData) return false;
                const files = Array.from(event.clipboardData.files);
                const imageFile = files.find(f => f.type.startsWith('image/'));
                if (imageFile && mediaFolderId) {
                    event.preventDefault();
                    handleImageUpload(imageFile);
                    return true;
                }
                return false;
            },
        },
    }, [handleCommentClick]);

    const handleImageUpload = async (file: File) => {
        if (!mediaFolderId || !file.type.startsWith('image/') || !editor) return;

        const result = await uploadFile.mutateAsync({parentId: mediaFolderId, file});
        if (result) {
            const src = getDriveEmbedUrl(path.ownerId, path.mountId, result.id, 'image');
            editor.chain().focus().setResizableImage({src}).run();
        }
    };

    const handleAddComment = () => {
        if (!editor || !chatFolderId) return;
        const {from, to} = editor.state.selection;
        const text = editor.state.doc.textBetween(from, to, ' ');
        if (!text.trim()) return;
        setCommentSelectedText(text);
        setCommentDialogOpen(true);
    };

    const handleCommentCreated = (chatId: string) => {
        if (!editor) return;
        editor.chain().focus().setComment(chatId).run();
    };

    if (!editor) return null;

    return (
        <>
            <div className="flex h-full w-full flex-col">
                <EditorToolbar
                    editor={editor}
                    path={path}
                    canWrite={access.canWrite}
                    onDeleteDialogOpen={onDeleteDialogOpen}
                    onAccessDialogOpen={onAccessDialogOpen}
                    onAddComment={chatFolderId ? handleAddComment : undefined}
                    onImageUpload={mediaFolderId ? handleImageUpload : undefined}
                />
                <div className="h-full w-full overflow-y-scroll bg-gray-200 p-4">
                    <div
                        data-document="true"
                        className="grid p-[2cm] bg-white rounded-lg shadow-sm shadow-transparent min-h-full w-[210mm] m-auto print:shadow-none"
                        ref={documentRef}
                    >
                        <EditorContent editor={editor} className="h-full tiptap-wrapper"/>
                    </div>
                </div>
                {editor && (
                    <div className="bg-white border-t px-4 py-1 text-xs text-muted-foreground flex items-center gap-4 no-print">
                        <span>{editor.storage.characterCount.characters()} characters</span>
                        <span>{editor.storage.characterCount.words()} words</span>
                    </div>
                )}
            </div>

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

            {viewCommentChatId && (
                <ViewCommentDialog
                    open={!!viewCommentChatId}
                    onOpenChange={(open) => { if (!open) setViewCommentChatId(null); }}
                    ownerId={path.ownerId}
                    mountId={path.mountId}
                    chatId={viewCommentChatId}
                />
            )}
        </>
    );
};
