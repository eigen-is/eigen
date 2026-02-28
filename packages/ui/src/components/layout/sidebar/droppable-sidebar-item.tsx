import {useListDropTarget} from '../../../hooks/use-list-drop-target';
import {SidebarItem, type SidebarItemProps} from './sidebar-item';
import {cn} from '../../../lib/utils';

type DroppableSidebarItemProps = SidebarItemProps & {
    acceptTypes: string[];
    onDrop: (data: { type: string; ids: string[] }) => void;
}

export function DroppableSidebarItem({acceptTypes, onDrop, className, ...props}: DroppableSidebarItemProps) {
    const {isOver, getDropProps} = useListDropTarget({acceptTypes, onDrop});
    return (
        <div {...getDropProps()}>
            <SidebarItem {...props} className={cn(className, isOver && "ring-2 ring-primary/50 bg-primary/10")}/>
        </div>
    );
}
