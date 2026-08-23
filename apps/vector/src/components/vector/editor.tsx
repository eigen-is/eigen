import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui';
import { ToolbarTitle, TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { useVectorDoc, VectorCanvas } from '@workspace/ui/components/vector';
import { Sparkles } from 'lucide-react';
import { useCallback } from 'react';

type VectorEditorProps = {
    ownerId: string;
    path: DrivePath;
};

// M1: a live scene rendered from Yjs. The tool palette, properties panel and pointer
// interaction land in M2 — this shell wires the doc hook to the canvas plus a temporary
// seed affordance.
export function VectorEditor({ ownerId, path }: VectorEditorProps) {
    const { elements, meta, addElement, synced } = useVectorDoc(ownerId, path.mountId, path.id);

    // TEMPORARY seed affordance — replaced by M2's shape tools. Deterministic layout, randomized
    // seeds (addElement generates each element's roughjs seed), covering every M1 render path:
    // rounded + sharp rectangles, a hachure-filled diamond, a solid-filled ellipse, dashed stroke,
    // and a two-line Excalifont text.
    const seedDemoScene = useCallback(() => {
        addElement({
            type: 'rectangle',
            roundness: 'round',
            x: 40,
            y: 40,
            width: 180,
            height: 120,
            backgroundColor: '#a5d8ff',
            fillStyle: 'hachure',
        });
        addElement({
            type: 'rectangle',
            roundness: 'sharp',
            x: 260,
            y: 40,
            width: 180,
            height: 120,
            strokeStyle: 'dashed',
        });
        addElement({
            type: 'diamond',
            x: 40,
            y: 200,
            width: 180,
            height: 120,
            backgroundColor: '#b2f2bb',
            fillStyle: 'cross-hatch',
        });
        addElement({
            type: 'ellipse',
            x: 260,
            y: 200,
            width: 180,
            height: 120,
            backgroundColor: '#ffec99',
            fillStyle: 'solid',
        });
        addElement({
            type: 'text',
            x: 40,
            y: 360,
            width: 320,
            height: 90,
            text: 'eigen|vector>\nhello canvas',
            fontSize: 36,
            fontFamily: 'Excalifont',
            textAlign: 'left',
        });
    }, [addElement]);

    return (
        <ColumnLayout>
            <Column
                id="editor"
                width="flex"
                toolbarBorder="always"
                toolbar={
                    <div className="flex w-full items-center justify-between">
                        <ToolbarTitle>{stripEigenExtension(path.name)}</ToolbarTitle>
                        <TooltipButton icon={Sparkles} tooltipText="Seed demo scene" onClick={seedDemoScene} />
                    </div>
                }
            >
                {!synced ? (
                    <LoadingState />
                ) : (
                    <div className="h-full bg-muted/30">
                        <VectorCanvas elements={elements} meta={meta} />
                    </div>
                )}
            </Column>
        </ColumnLayout>
    );
}
