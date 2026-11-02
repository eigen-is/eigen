// The table's properties panel, which opens beside the page while the selection is in a table: its columns, rows and
// cells, the selected cells' fill and borders, and Delete table. Every control runs a command of the editor that holds
// the table, as Format › Table does.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { readHexColor } from '@workspace/lib/constants/colors';
import { Button } from '@workspace/ui/components/button';
import { ColorRow, PropertiesPanel, PropertyRow, PropertySection } from '@workspace/ui/components/properties-panel';
import { cellBorderPen } from './extensions/table-look';
import { cellBackground, selectCellCommands } from './hooks/use-toolbar-state';
import type { TableAction, TableCommand } from './table-actions';
import { BORDER_SET_LOOKS, TABLE_ACTIONS } from './table-actions';

type TablePropertiesPanelProps = {
    editor: Editor;
};

export function TablePropertiesPanel({ editor }: TablePropertiesPanelProps) {
    // The panel stays mounted through its exit, so a caret that has left the table reads no cell command.
    const { fill, borderColor, ...cells } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const inTable = e.isActive('table');
            return {
                ...selectCellCommands(e, inTable),
                fill: inTable ? cellBackground(e.state) : '',
                borderColor: cellBorderPen(e.state)?.color ?? '',
            };
        },
    });
    const button = (command: TableCommand, className = 'text-xs') => {
        const { icon: Icon, label, short = label, enabledBy }: TableAction = TABLE_ACTIONS[command];
        return (
            <Button
                variant="outline"
                size="sm"
                className={className}
                disabled={enabledBy !== undefined && !cells[enabledBy]}
                onClick={() => editor.chain().focus()[command]().run()}
            >
                <Icon className="h-3.5 w-3.5 mr-1" /> {short}
            </Button>
        );
    };
    return (
        <PropertiesPanel title="Table">
            <PropertySection title="Columns">
                <div className="grid grid-cols-2 gap-1.5">
                    {button('addColumnBefore')}
                    {button('addColumnAfter')}
                </div>
                {button('deleteColumn', 'w-full text-xs')}
                {button('distributeColumns', 'w-full text-xs')}
            </PropertySection>

            <PropertySection title="Rows">
                <div className="grid grid-cols-2 gap-1.5">
                    {button('addRowBefore')}
                    {button('addRowAfter')}
                </div>
                {button('deleteRow', 'w-full text-xs')}
            </PropertySection>

            <PropertySection title="Cells">
                <div className="grid grid-cols-2 gap-1.5">
                    {button('mergeCells')}
                    {button('splitCell')}
                </div>
                {button('toggleHeaderRow', 'w-full text-xs')}
                {/* None writes the transparent token, which reads as no fill. */}
                <ColorRow
                    label="Fill"
                    value={fill}
                    allowNone
                    onChange={(color) =>
                        editor.chain().focus().setCellAttribute('backgroundColor', readHexColor(color)).run()
                    }
                />
                <PropertyRow label="Borders">
                    <div className="grid grid-cols-3 gap-1.5">
                        {BORDER_SET_LOOKS.map(({ set, short }) => (
                            <Button
                                key={set}
                                variant="outline"
                                size="sm"
                                className="text-xs"
                                onClick={() => editor.chain().focus().setCellBorders(set).run()}
                            >
                                {short}
                            </Button>
                        ))}
                    </div>
                </PropertyRow>
                {/* Without a color of their own the sides draw Eigen's default gray. */}
                <ColorRow
                    label="Border"
                    value={borderColor}
                    noneLabel="Default"
                    onChange={(color) => editor.chain().focus().setCellBorderColor(color).run()}
                />
            </PropertySection>

            <div className="app-gutter">
                <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => editor.chain().focus().deleteTable().run()}
                >
                    <TABLE_ACTIONS.deleteTable.icon className="h-3.5 w-3.5 mr-1.5" /> {TABLE_ACTIONS.deleteTable.label}
                </Button>
            </div>
        </PropertiesPanel>
    );
}
