import {Eye, Pencil} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {Tooltip, TooltipContent, TooltipTrigger,} from "@workspace/ui/components/tooltip";


export type DocumentModeButtonProps = {
    canWrite: boolean;
}

export const DocumentModeButton = ({
                                       canWrite
                                   }: DocumentModeButtonProps) => {
    return (
        <>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        onClick={() => {
                        }}
                    >
                        {canWrite ? <Pencil className="h-4 w-4"/> : <Eye className="h-4 w-4"/>}
                        {canWrite ? 'Editing' : 'Read-only'}
                    </Button>
                </TooltipTrigger>
                <TooltipContent>{
                    canWrite ?
                        'You can edit this document because you are Editor' :
                        'You can only read this document because you\'re set to Viewer'
                }</TooltipContent>
            </Tooltip>
        </>
    );
};