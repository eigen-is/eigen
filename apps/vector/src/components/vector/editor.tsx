import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import {
    useSelection,
    useTool,
    useVectorDoc,
    VECTOR_TOOLS,
    VectorCanvas,
    VectorPropertiesPanel,
} from '@workspace/ui/components/vector';
import { useMemo } from 'react';

type VectorEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
};

// The live scene plus pointer/keyboard interaction. Tool and selection state are lifted here so the
// toolbar, canvas, and properties panel share one source (the slides editor/canvas idiom); viewport
// and gestures stay in the canvas.
export function VectorEditor({ ownerId, path, canWrite }: VectorEditorProps) {
    const doc = useVectorDoc(ownerId, path.mountId, path.id);
    const { tool, setTool } = useTool();
    const { selectedIds, setSelectedIds, toggle } = useSelection();

    const selectedElements = useMemo(
        () => doc.elements.filter((el) => selectedIds.includes(el.id)),
        [doc.elements, selectedIds],
    );
    const showPanel = canWrite && selectedElements.length > 0;

    return (
        <ColumnLayout>
            <Column
                id="editor"
                width="flex"
                toolbarBorder="always"
                toolbar={
                    <div className="flex w-full items-center gap-2">
                        <ToolbarTitle>{stripEigenExtension(path.name)}</ToolbarTitle>
                        {canWrite && (
                            <div className="ml-auto flex items-center gap-1">
                                {VECTOR_TOOLS.map((t) => (
                                    <Tooltip key={t.tool}>
                                        <TooltipTrigger asChild>
                                            {/* aria-pressed styling, not data-state: TooltipTrigger asChild clobbers data-state */}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-pressed={tool === t.tool}
                                                aria-label={t.label}
                                                className="h-8 w-8 aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/20 aria-pressed:hover:text-primary"
                                                onClick={() => setTool(t.tool)}
                                            >
                                                <t.icon className="h-4 w-4" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>{`${t.label} (${t.shortcut})`}</TooltipContent>
                                    </Tooltip>
                                ))}
                            </div>
                        )}
                    </div>
                }
            >
                {!doc.synced ? (
                    <LoadingState />
                ) : (
                    <div className="flex h-full w-full overflow-hidden">
                        <div className="flex-1 min-w-0">
                            <VectorCanvas
                                elements={doc.elements}
                                meta={doc.meta}
                                tool={tool}
                                setTool={setTool}
                                canWrite={canWrite}
                                addElement={doc.addElement}
                                updateElement={doc.updateElement}
                                updateElements={doc.updateElements}
                                deleteElements={doc.deleteElements}
                                duplicateElements={doc.duplicateElements}
                                undoManager={doc.undoManager}
                                selectedIds={selectedIds}
                                setSelectedIds={setSelectedIds}
                                toggle={toggle}
                            />
                        </div>
                        {showPanel && (
                            <VectorPropertiesPanel
                                elements={doc.elements}
                                selectedElements={selectedElements}
                                updateElements={doc.updateElements}
                                undoManager={doc.undoManager}
                            />
                        )}
                    </div>
                )}
            </Column>
        </ColumnLayout>
    );
}
