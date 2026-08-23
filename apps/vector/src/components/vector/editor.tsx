import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Column, ColumnLayout } from '@workspace/ui';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';

type VectorEditorProps = {
    path: DrivePath;
};

// M0 placeholder shell: AppShell (from EigenDocRoot) + toolbar title + an empty
// full-bleed canvas area. The interactive vector engine lands in a later milestone.
export function VectorEditor({ path }: VectorEditorProps) {
    return (
        <ColumnLayout>
            <Column
                id="editor"
                width="flex"
                toolbarBorder="always"
                toolbar={<ToolbarTitle>{stripEigenExtension(path.name)}</ToolbarTitle>}
            >
                <div className="h-full bg-muted/30" />
            </Column>
        </ColumnLayout>
    );
}
