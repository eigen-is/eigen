import {useCallback, useEffect, useMemo, useState, useRef} from "react";
import {createEditor, Editor, Node, NodeEntry, Transforms} from "slate";
import {Editable, ReactEditor, RenderElementProps, RenderLeafProps, Slate, withReact} from "slate-react";
import {withCursors, withYjs, YjsEditor} from "@slate-yjs/core";
import * as Y from "yjs";
import {WebsocketProvider} from "y-websocket";
import {Cursors} from "./cursors";
import {useAuth} from "@workspace/lib/auth/auth-context.js";
import {withHistory} from "slate-history";
import {EditorToolbar} from "./editor-toolbar";
import {CustomElement} from "./editor.types";
import {EigenLoader} from "@workspace/ui";
import { DrivePath } from "@apps/api-server/types/drive";

// Define the initial value with proper typing
const initialValue: CustomElement[] = [
    {
        type: "paragraph",
        children: [{text: ""}],
    },
];

export const CollaborativeEditor = ({ownerId, path, access, onAccessDialogOpen}: {
    ownerId: string, path: DrivePath, access: {
        canRead: boolean;
        canWrite: boolean;
    }, onAccessDialogOpen: () => void
}) => {
    const [connected, setConnected] = useState(false);
    const [provider, setProvider] = useState<WebsocketProvider>();
    const auth = useAuth();
    const slug = ``;

    const yDoc = useMemo(() => new Y.Doc(), []);
    const sharedType = useMemo(() => yDoc.get('slate', Y.XmlText), [yDoc]);

    useEffect(() => {
        // Build WebSocket URL
        const wsUrl = `${import.meta.env.VITE_API_HOST}/ws/collab/${ownerId}/${path.id}`;

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
    }, [yDoc, auth]);

    if (!connected || !sharedType || !provider) {
        return <div className="flex h-full items-center justify-center"><EigenLoader/></div>;
    }

    return <>
        <SlateEditor path={path} sharedType={sharedType} provider={provider} access={access}
                     onAccessDialogOpen={onAccessDialogOpen}/>
    </>;
};


const SlateEditor = ({
                         sharedType,
                         provider,
                         path,
                         access,
                         onAccessDialogOpen,
                     }: {
    sharedType: Y.XmlText | null;
    provider: WebsocketProvider | null;
    path: DrivePath;
    access: { canRead: boolean, canWrite: boolean };
    onAccessDialogOpen: () => void;
}) => {
    const auth = useAuth();
    const [scale, setScale] = useState(1);
    const documentRef = useRef<HTMLDivElement>(null);

    // Calculate scale factor based on screen width
    useEffect(() => {
        const calculateScale = () => {
            // A4 paper width is 210mm (approximately 793px)
            const documentWidth = 793; // 210mm in pixels
            const padding = 32; // Container padding (16px on each side)
            const availableWidth = window.innerWidth - padding;
            
            // Only scale down if needed, never scale up
            const newScale = Math.min(1, availableWidth / documentWidth);
            setScale(newScale);
        };

        calculateScale();
        // Recalculate on window resize
        window.addEventListener('resize', calculateScale);
        
        // Small delay to ensure proper calculation after render
        const timer = setTimeout(calculateScale, 100);
        
        return () => {
            window.removeEventListener('resize', calculateScale);
            clearTimeout(timer);
        };
    }, []);

    const editor = useMemo(() => {
        const e = withReact(
            withHistory(
                withCursors(withYjs(createEditor(), sharedType!), provider!.awareness, {
                    // The current user's name and color
                    data: {
                        name: auth.user.name,
                        email: auth.user.email,
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
                                const path = ReactEditor.findPath(editor, typedElement);
                                Transforms.setNodes(
                                    editor,
                                    {checked: event.target.checked},
                                    {at: path}
                                );
                            }}
                            className="mt-1.5"
                        />
                        <span className="flex-1">{children}</span>
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

    return (
        <>
            <Slate editor={editor} initialValue={initialValue}>
                <div className="flex h-full w-full flex-col">
                    <EditorToolbar path={path} canWrite={access.canWrite} onAccessDialogOpen={onAccessDialogOpen}/>
                    <div className="h-full w-full bg-gray-200 overflow-y-auto p-4  overflow-x-hidden flex flex-col items-center">
                        <div 
                            style={{ 
                                transform: `scale(${scale})`,
                                transformOrigin: 'top center',
                                width: '210mm',
                                height: `calc(100% / ${scale})`,
                            }}
                        >
                            <div 
                                ref={documentRef}
                                data-document
                                className="bg-white rounded-lg shadow-lg w-full p-[2cm] relative"
                                style={{ 
                                    minHeight: `calc((100dvh - 120px) / ${scale})`
                                }}
                            >
                                <Cursors className="h-full absolute inset-0">
                                    <Editable
                                        readOnly={!access.canWrite}
                                        spellCheck={false}
                                        autoFocus
                                        className="outline-none h-full"
                                        renderElement={renderElement}
                                        renderLeaf={renderLeaf}
                                        onKeyDown={handleKeyDown}
                                    />
                                </Cursors>
                            </div>
                        </div>
                    </div>
                </div>
            </Slate>
        </>
    );
};
