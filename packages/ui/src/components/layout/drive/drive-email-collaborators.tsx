import { getDriveShareUrl } from '@workspace/lib/api';
import { useEmailCollaborators } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Label } from '@workspace/ui/components/label';
import { LightEditor } from '@workspace/ui/components/layout/editor/light-editor';
import { useEffect, useState } from 'react';

type DriveEmailCollaboratorsProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

const MESSAGE_TEXT_LIMIT = 10000;

export function DriveEmailCollaborators({ path, open, onOpenChange }: DriveEmailCollaboratorsProps) {
    const [message, setMessage] = useState('');
    const [messageText, setMessageText] = useState('');
    const [sendCopyToSelf, setSendCopyToSelf] = useState(true);
    const emailMutation = useEmailCollaborators(path.ownerId, path.mountId);

    useEffect(() => {
        if (open) {
            setMessage('');
            setMessageText('');
            setSendCopyToSelf(true);
        }
    }, [open]);

    const handleSend = () => {
        const documentUrl = getDriveShareUrl(path);

        emailMutation.mutate(
            {
                pathId: path.id,
                message,
                documentUrl,
                sendCopyToSelf,
            },
            {
                onSuccess: () => onOpenChange(false),
            },
        );
    };

    const overLimit = messageText.length > MESSAGE_TEXT_LIMIT;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>Email collaborators</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label>Message</Label>
                        <div className="rounded-md border">
                            <LightEditor
                                content={message}
                                onChange={setMessage}
                                onChangeText={setMessageText}
                                placeholder="Write a message..."
                                className="px-3 py-2"
                                containerClassName="min-h-[180px] flex flex-col"
                            />
                        </div>
                        <div className="text-xs text-muted-foreground text-right">
                            {messageText.length.toLocaleString()}/{MESSAGE_TEXT_LIMIT.toLocaleString()}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Checkbox
                            id="email-copy-self"
                            checked={sendCopyToSelf}
                            onCheckedChange={(v) => setSendCopyToSelf(v === true)}
                        />
                        <Label htmlFor="email-copy-self" className="text-sm font-normal">
                            Send copy to self
                        </Label>
                    </div>
                </div>
                <p className="text-xs text-muted-foreground">A link to the document will be included in the message</p>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={emailMutation.isPending}>
                        Cancel
                    </Button>
                    <Button onClick={handleSend} disabled={!messageText.trim() || overLimit || emailMutation.isPending}>
                        {emailMutation.isPending ? 'Sending...' : 'Send'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
