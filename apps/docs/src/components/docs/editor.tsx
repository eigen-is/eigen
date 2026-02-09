import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {createEditor, Descendant, Editor, Element, Node, NodeEntry, Transforms} from "slate";
import {Editable, ReactEditor, RenderElementProps, RenderLeafProps, Slate, withReact} from "slate-react";
import {withCursors, withYjs, YjsEditor} from "@slate-yjs/core";
import * as Y from "yjs";
import {WebsocketProvider} from "y-websocket";
import {Cursors} from "./cursors";
import {useAuth} from "@workspace/lib/auth";
import {withHistory} from "slate-history";
import {EditorToolbar} from "./editor-toolbar";
import {CustomElement} from "./editor.types";
import {EigenLoader} from "@workspace/ui";
import {DrivePath} from "@workspace/lib/types/drive";
import {getCollabWebSocketUrl, getDriveEmbedUrl} from "@workspace/lib/api";
import {useUploadFile, useDeleteFile} from "@workspace/lib/drive";

// Define the initial value with proper typing
const initialValue: CustomElement[] = [
    {
        type: "paragraph",
        children: [{text: ""}],
    },
];

export const CollaborativeEditor = ({path, access, mediaFolderId, onAccessDialogOpen, onDeleteDialogOpen}: {
    path: DrivePath,
    access: { canRead: boolean; canWrite: boolean; },
    mediaFolderId: string | null,
    onAccessDialogOpen: () => void,
    onDeleteDialogOpen: (open: boolean) => void
}) => {
    const [connected, setConnected] = useState(false);
    const [provider, setProvider] = useState<WebsocketProvider>();
    const slug = ``;

    const yDoc = useMemo(() => new Y.Doc(), []);
    const sharedType = useMemo(() => yDoc.get('slate', Y.XmlText), [yDoc]);

    useEffect(() => {
        // Build WebSocket URL
        const wsUrl = getCollabWebSocketUrl(path.ownerId, path.mountId, path.id);

        // Create WebSocket provider
        const yProvider = new WebsocketProvider(wsUrl, slug, yDoc, {
            resyncInterval: 5000,
            connect: true,
        });
        yProvider.on("sync", setConnected);
        /*
        yProvider.awareness.on('change', () => {
            console.log(Array.from(yProvider.awareness.getStates().values()));
        });
        */

        setProvider(yProvider);

        return () => {
            yProvider?.off("sync", setConnected);
            yProvider?.destroy();
        };
    }, [yDoc, path.ownerId, path.id]);

    if (!connected || !sharedType || !provider) {
        return <div className="flex h-full items-center justify-center"><EigenLoader/></div>;
    }

    return <>
        <SlateEditor path={path} sharedType={sharedType} provider={provider} access={access}
                     mediaFolderId={mediaFolderId}
                     onAccessDialogOpen={onAccessDialogOpen}
                     onDeleteDialogOpen={onDeleteDialogOpen}/>
    </>;
};


const SlateEditor = ({
                         sharedType,
                         provider,
                         path,
                         access,
                         mediaFolderId,
                         onAccessDialogOpen,
                         onDeleteDialogOpen,
                     }: {
    sharedType: Y.XmlText | null;
    provider: WebsocketProvider | null;
    path: DrivePath;
    access: { canRead: boolean, canWrite: boolean };
    mediaFolderId: string | null;
    onAccessDialogOpen: () => void;
    onDeleteDialogOpen: (open: boolean) => void;
}) => {
    const auth = useAuth();
    const uploadFile = useUploadFile(path.ownerId, path.mountId);
    const deleteFile = useDeleteFile(path.ownerId, path.mountId, mediaFolderId ?? undefined);
    const previousImageIds = useRef<Set<string>>(new Set());

    const getImageIds = useCallback((nodes: Descendant[]): Set<string> => {
        const ids = new Set<string>();
        const traverse = (node: Descendant) => {
            if (Element.isElement(node)) {
                if (node.type === 'image' && (node as CustomElement).pathId) {
                    ids.add((node as CustomElement).pathId!);
                }
                node.children.forEach(traverse);
            }
        };
        nodes.forEach(traverse);
        return ids;
    }, []);

    const editor = useMemo(() => {
        const e = withReact(
            withHistory(
                withCursors(withYjs(createEditor(), sharedType!), provider!.awareness, {
                    // The current user's name and color
                    data: {
                        name: auth.user!.name,
                        email: auth.user!.email,
                        color: "#9810fa",
                    },
                })
            )
        );

        // Ensure editor always has at least 1 valid child
        const {normalizeNode} = e;
        e.normalizeNode = (entry: NodeEntry<Node>) => {
            const [node] = entry;

            if (!Editor.isEditor(node) || node.children.length > 0) {
                return normalizeNode(entry);
            }

            Transforms.insertNodes(e, initialValue, {at: [0]});
        };

        return e;
    }, []);

    useEffect(() => {
        YjsEditor.connect(editor);
        return () => YjsEditor.disconnect(editor);
    }, [editor]);

    // Define custom element renderer
    const renderElement = useCallback((props: RenderElementProps) => {
        const {attributes, children, element} = props;
        const style: React.CSSProperties = {
            textAlign: element.align || 'left',
        };

        const typedElement = element as CustomElement;

        switch (typedElement.type) {
            case 'heading-one':
                return <h1 className="text-4xl font-normal mb-3" style={style} {...attributes}>{children}</h1>;
            case 'heading-two':
                return <h2 className="text-3xl font-normal mb-3" style={style} {...attributes}>{children}</h2>;
            case 'heading-three':
                return <h3 className="text-2xl font-normal mb-3" style={style} {...attributes}>{children}</h3>;
            case 'block-quote':
                return <blockquote className="border-l-2 border-muted-foreground pl-2"
                                   style={style} {...attributes}>{children}</blockquote>;
            case 'bulleted-list':
                return <ul className="list-disc pl-4 pt-2" style={style} {...attributes}>{children}</ul>;
            case 'numbered-list':
                return <ol className="list-decimal pl-4 pt-2" style={style} {...attributes}>{children}</ol>;
            case 'list-item':
                return <li className="my-1" style={style} {...attributes}>{children}</li>;
            case 'check-list':
                return (
                    <div
                        {...attributes}
                        className="flex items-start gap-2"
                    >
                        <input
                            type="checkbox"
                            checked={typedElement.checked}
                            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                                const nodePath = ReactEditor.findPath(editor, typedElement);
                                Transforms.setNodes(
                                    editor,
                                    {checked: event.target.checked},
                                    {at: nodePath}
                                );
                            }}
                            className="mt-1.5"
                        />
                        <span className="flex-1">{children}</span>
                    </div>
                );
            case 'image':
                return (
                    <div {...attributes} contentEditable={false} className="my-2">
                        <img
                            src={getDriveEmbedUrl(path.ownerId, path.mountId, typedElement.pathId!, 'image')}
                            alt=""
                            className="max-w-full rounded"
                            style={style}
                        />
                        {children}
                    </div>
                );
            default:
                return <p style={style} {...attributes}>{children}</p>;
        }
    }, [editor]);

    // Define custom leaf renderer
    const renderLeaf = useCallback((props: RenderLeafProps) => {
        const {attributes, leaf} = props;
        let {children} = props;

        if (leaf.bold) {
            children = <strong>{children}</strong>;
        }

        if (leaf.italic) {
            children = <em>{children}</em>;
        }

        if (leaf.underline) {
            children = <u>{children}</u>;
        }

        if (leaf.strikethrough) {
            children = <s>{children}</s>;
        }

        if (leaf.code) {
            children = <code>{children}</code>;
        }

        if (leaf.link) {
            children = (
                <a
                    href={leaf.link as string}
                    className="text-blue-600 underline"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {children}
                </a>
            );
        }

        return <span {...attributes}>{children}</span>;
    }, []);

    // Handle keyboard shortcuts
    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const {key, ctrlKey, metaKey} = event;
        const isModKey = metaKey || ctrlKey;

        // Handle keyboard shortcuts
        if (isModKey) {
            switch (key) {
                case 'b': {
                    event.preventDefault();
                    Editor.addMark(editor, 'bold', true);
                    break;
                }
                case 'i': {
                    event.preventDefault();
                    Editor.addMark(editor, 'italic', true);
                    break;
                }
                case 'u': {
                    event.preventDefault();
                    Editor.addMark(editor, 'underline', true);
                    break;
                }
            }
        }
    }, [editor]);

    const insertImage = useCallback((pathId: string) => {
        const image: CustomElement = {
            type: 'image',
            pathId,
            children: [{text: ''}],
        };
        Transforms.insertNodes(editor, image);
        Transforms.insertNodes(editor, {type: 'paragraph', children: [{text: ''}]});
    }, [editor]);

    const handleImageUpload = useCallback(async (file: File) => {
        if (!mediaFolderId || !file.type.startsWith('image/')) return;
        
        const result = await uploadFile.mutateAsync({parentId: mediaFolderId, file});
        if (result) {
            insertImage(result.id);
        }
    }, [mediaFolderId, uploadFile, insertImage]);

    const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        const files = Array.from(event.dataTransfer.files);
        const imageFile = files.find(f => f.type.startsWith('image/'));
        if (imageFile && mediaFolderId) {
            event.preventDefault();
            handleImageUpload(imageFile);
        }
    }, [mediaFolderId, handleImageUpload]);

    const handlePaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
        const files = Array.from(event.clipboardData.files);
        const imageFile = files.find(f => f.type.startsWith('image/'));
        if (imageFile && mediaFolderId) {
            event.preventDefault();
            handleImageUpload(imageFile);
        }
    }, [mediaFolderId, handleImageUpload]);

    const handleChange = useCallback((value: Descendant[]) => {
        const currentImageIds = getImageIds(value);
        const removedIds = [...previousImageIds.current].filter(id => !currentImageIds.has(id));
        
        for (const pathId of removedIds) {
            deleteFile.mutate(pathId);
        }
        
        previousImageIds.current = currentImageIds;
    }, [getImageIds, deleteFile]);

    return (
        <>
            <Slate editor={editor} initialValue={initialValue} onChange={handleChange}>
                <div className="flex h-full w-full flex-col">
                    <EditorToolbar path={path} canWrite={access.canWrite} onDeleteDialogOpen={onDeleteDialogOpen}
                                   onAccessDialogOpen={onAccessDialogOpen}/>
                    <div className="h-full w-full overflow-y-scroll bg-gray-200 p-4">
                        <div data-document
                             className="grid p-[2cm] bg-white rounded-lg shadow-sm shadow-transparent min-h-full w-[210mm] m-auto print:shadow-none">
                            <Cursors className="h-full">
                                <Editable
                                    readOnly={!access.canWrite}
                                    spellCheck={false}
                                    autoFocus
                                    className="h-full outline-none"
                                    renderElement={renderElement}
                                    renderLeaf={renderLeaf}
                                    onKeyDown={handleKeyDown}
                                    onDrop={handleDrop}
                                    onPaste={handlePaste}
                                />
                            </Cursors>
                        </div>
                    </div>
                </div>
            </Slate>
        </>
    );
};
