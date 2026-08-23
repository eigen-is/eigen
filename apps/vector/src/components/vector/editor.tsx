import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { useTool, useVectorDoc, VECTOR_TOOLS, VectorCanvas } from '@workspace/ui/components/vector';

type VectorEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
};

// M2: the live scene plus pointer/keyboard interaction. Tool state is lifted here so the toolbar
// and the canvas share one source; everything else (viewport, selection, gestures) lives in the
// canvas. The properties panel and text/image tools land in M3.
export function VectorEditor({ ownerId, path, canWrite }: VectorEditorProps) {
    const doc = useVectorDoc(ownerId, path.mountId, path.id);
    const { tool, setTool } = useTool();

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
                    />
                )}
            </Column>
        </ColumnLayout>
    );
}
