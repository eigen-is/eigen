import { cn } from '@workspace/ui/lib/utils';
import { Camera } from 'lucide-react';
import { useRef } from 'react';
import { Button } from './button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';
import { UserAvatar } from './user/user-avatar';

export type AvatarEditorProps = {
    name?: string;
    email?: string;
    userId?: string;
    imageUrl?: string;
    onUpload: (file: File) => void | Promise<void>;
    onRemove?: () => void | Promise<void>;
    className?: string;
};

export function AvatarEditor({ name, email, userId, imageUrl, onUpload, onRemove, className }: AvatarEditorProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    return (
        <div className={cn('group relative h-32 w-32', className)}>
            <UserAvatar name={name} email={email} userId={userId} imageUrl={imageUrl} className="h-full w-full" />

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    await onUpload(file);
                }}
            />

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        size="icon"
                        variant="secondary"
                        className="absolute bottom-1 right-1 rounded-full h-8 w-8 shadow-md opacity-80 hover:opacity-100"
                    >
                        <Camera className="h-4 w-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                        Upload from files
                    </DropdownMenuItem>
                    {onRemove && <DropdownMenuItem onSelect={() => onRemove()}>Remove avatar</DropdownMenuItem>}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
