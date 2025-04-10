import { useEffect, useMemo, useState } from "react";
import { createEditor, Editor, Transforms } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { withCursors, withYjs, YjsEditor } from "@slate-yjs/core";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Cursors } from "./cursors";
import { useAuth } from "@workspace/lib/auth/auth-context.js";
import { Button } from "@workspace/ui/components/button";
import {
  ArrowLeft,
  Bold,
  Copy,
  FileText,
  Folder,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Italic,
  List,
  ListCheck,
  ListOrdered,
  MoreVertical,
  Printer,
  Redo,
  RemoveFormatting,
  Search,
  SpellCheck,
  Strikethrough,
  Trash,
  Underline,
  Undo,
} from "lucide-react";
import { TooltipButton } from "@workspace/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Input } from "@workspace/ui/components/input";
import { Separator } from "@workspace/ui/components/separator";

const initialValue = [
  {
    type: "paragraph",
    children: [{ text: "Type something..." }],
  },
];

export const CollaborativeEditor = () => {
  const [connected, setConnected] = useState(false);
  const [sharedType, setSharedType] = useState<Y.XmlText | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);

  // Connect to your Yjs provider and document
  useEffect(() => {
    const yDoc = new Y.Doc();
    const sharedDoc = yDoc.get("slate", Y.XmlText);

    // Build WebSocket URL
    const wsUrl = `${import.meta.env.VITE_API_HOST}/ws/collab/userid/`;
    const documentId = "foo";

    // Create WebSocket provider
    const provider = new WebsocketProvider(wsUrl, documentId, yDoc, {
      resyncInterval: 5000,
      connect: true,
    });

    // Set up your Yjs provider. This line of code is different for each provider.
    const yProvider = provider;

    yProvider.on("sync", setConnected);
    setSharedType(sharedDoc);
    setProvider(provider);

    return () => {
      yDoc?.destroy();
      yProvider?.off("sync", setConnected);
      yProvider?.destroy();
    };
  }, []);

  if (!connected || !sharedType || !provider) {
    return <div>Loading…</div>;
  }

  return <SlateEditor sharedType={sharedType} provider={provider} />;
};

const SlateEditor = ({
  sharedType,
  provider,
}: {
  sharedType: Y.XmlText | null;
  provider: WebsocketProvider | null;
}) => {
  const auth = useAuth();

  const editor = useMemo(() => {
    const e = withReact(
      withCursors(withYjs(createEditor(), sharedType!), provider!.awareness, {
        // The current user's name and color
        data: {
          name: auth.user?.name,
          email: auth.user?.email,
          color: "#660044",
        },
      })
    );

    // Ensure editor always has at least 1 valid child
    const { normalizeNode } = e;
    e.normalizeNode = (entry) => {
      const [node] = entry;

      if (!Editor.isEditor(node) || node.children.length > 0) {
        return normalizeNode(entry);
      }

      Transforms.insertNodes(e, initialValue, { at: [0] });
    };

    return e;
  }, []);

  useEffect(() => {
    YjsEditor.connect(editor);
    return () => YjsEditor.disconnect(editor);
  }, [editor]);

  return (
    <>
      <div className="bg-white h-12 flex items-center justify-between px-4 border-b mb-0 no-print">
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" title="File">
                File
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <FileText /> New
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Folder /> Open
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Copy /> Make a Copy
              </DropdownMenuItem>
              <Separator />
              <DropdownMenuItem onClick={() => window.print()}>
                <Printer /> Print
              </DropdownMenuItem>
              <Separator />
              <DropdownMenuItem onClick={() => editor.delete()}>
                <Trash /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" title="Edit">
                Edit
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <Undo /> Undo
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Redo /> Redo
              </DropdownMenuItem>
              <Separator />
              <DropdownMenuItem>
                <RemoveFormatting /> Clear formatting
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" title="Edit">
                Format
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <Bold /> Bold
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Italic /> Italic
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Underline /> Underline
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Strikethrough /> Strikethrough
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="bg-white h-12 flex items-center justify-between px-4 border-b mb-4 no-print">
        <div className="flex items-center gap-1">
          {/* Search */}
          <div className="flex items-center h-12 px-4 border-b">
            <div className="relative w-full">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search in document..."
                className="pl-8 w-full h-9"
              />
            </div>
          </div>

          <TooltipButton
            icon={Undo}
            tooltipText="Undo"
            onClick={() => {
              // TODO
            }}
          />
          <TooltipButton
            icon={Redo}
            tooltipText="Redo"
            onClick={() => {
              // TODO
            }}
          />

          {/* Separator */}
          <div className="h-6 w-[1px] bg-border mx-1"></div>

          <TooltipButton
            icon={Bold}
            tooltipText="Bold"
            onClick={() => {
              // TODO
            }}
          />

          <TooltipButton
            icon={Italic}
            tooltipText="Italic"
            onClick={() => {
              // TODO
            }}
          />

          <TooltipButton
            icon={Underline}
            tooltipText="Underline"
            onClick={() => {
              // TODO
            }}
          />

          <TooltipButton
            icon={Strikethrough}
            tooltipText="Strikethrough"
            onClick={() => {
              // TODO
            }}
          />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" title="Headings">
                Heading
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <Heading1 /> Heading 1
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Heading2 /> Heading 2
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Heading3 /> Heading 3
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Separator */}
          <div className="h-6 w-[1px] bg-border mx-1"></div>

          <TooltipButton
            icon={ListCheck}
            tooltipText="Checklist"
            onClick={() => {
              // TODO
            }}
          />

          <TooltipButton
            icon={List}
            tooltipText="Bulleted List"
            onClick={() => {
              // TODO
            }}
          />

          <TooltipButton
            icon={ListOrdered}
            tooltipText="Numbered List"
            onClick={() => {
              // TODO
            }}
          />

          {/* Separator */}
          <div className="h-6 w-[1px] bg-border mx-1"></div>

          <TooltipButton
            icon={RemoveFormatting}
            tooltipText="Clear formatting"
            onClick={() => {
              // TODO
            }}
          />
        </div>

        <div className="flex items-center gap-1">
          {/* Right side icons */}
          <TooltipButton
            icon={Printer}
            tooltipText="Print"
            onClick={() => window.print()}
          />

          <div className="h-6 w-[1px] bg-border mx-1"></div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" title="More actions">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <SpellCheck className="h-4 w-4" /> Spell check
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.print()}>
                <Printer className="h-4 w-4" /> Print
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="p-[2cm] bg-white rounded-lg shadow-sm w-[210mm] min-h-fit min-h-[297mm] m-auto">
        {/* Action toolbar */}
        <Slate editor={editor} initialValue={initialValue}>
          <Cursors>
            <Editable spellCheck={false} autoFocus className="min-h-[250mm] outline-none" />
          </Cursors>
        </Slate>
      </div>
    </>
  );
};
