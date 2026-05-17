import { Check, Palette, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '../../dropdown-menu';
import { ColorSwatchRow } from './color-swatch-row';

type NoteCardContextMenuProps = {
    currentColor?: string | null;
    onEdit?: () => void;
    onChangeColor?: (color: string) => void;
    onDelete?: () => void;
    onResolve?: () => void;
    onReopen?: () => void;
    status?: 'open' | 'resolved';
};

export function NoteCardContextMenu({
    currentColor,
    onEdit,
    onChangeColor,
    onDelete,
    onResolve,
    onReopen,
    status,
}: NoteCardContextMenuProps) {
    return (
        <>
            {onEdit && (
                <DropdownMenuItem onClick={onEdit}>
                    <Pencil className="h-4 w-4 mr-2" /> Edit
                </DropdownMenuItem>
            )}
            {onChangeColor && (
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Palette className="h-4 w-4 mr-2" /> Color
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <ColorSwatchRow currentColor={currentColor} onChangeColor={onChangeColor} />
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            )}
            {status === 'open' && onResolve && (
                <DropdownMenuItem onClick={onResolve}>
                    <Check className="h-4 w-4 mr-2" /> Resolve
                </DropdownMenuItem>
            )}
            {status === 'resolved' && onReopen && (
                <DropdownMenuItem onClick={onReopen}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Reopen
                </DropdownMenuItem>
            )}
            {onDelete && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={onDelete}>
                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                    </DropdownMenuItem>
                </>
            )}
        </>
    );
}
