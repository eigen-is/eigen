import { EIGEN_STICKIES_COLORS, isLightColor } from '@workspace/lib/constants';
import { Check, Palette, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '../../dropdown-menu';

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
                        <div className="flex gap-1 p-2">
                            {EIGEN_STICKIES_COLORS[0].map((c) => (
                                <button
                                    type="button"
                                    key={c.value}
                                    className="h-4 w-4 rounded-full border border-border/50 hover:scale-125 transition-transform flex items-center justify-center"
                                    style={{ backgroundColor: c.value }}
                                    title={c.label}
                                    onClick={() => onChangeColor(c.value)}
                                >
                                    {currentColor === c.value && (
                                        <Check
                                            className="h-2 w-2"
                                            style={{ color: isLightColor(c.value) ? '#000' : '#fff' }}
                                        />
                                    )}
                                </button>
                            ))}
                        </div>
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
