import {getDocumentUrl} from '@workspace/lib/api';
import {useEmailCollaborators} from '@workspace/lib/drive';
import type {DrivePath} from '@workspace/lib/types/drive';
import {Button} from '@workspace/ui/components/button';
import {Checkbox} from '@workspace/ui/components/checkbox';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Input} from '@workspace/ui/components/input';
import {Label} from '@workspace/ui/components/label';
import {Textarea} from '@workspace/ui/components/textarea';
import {useEffect, useState} from 'react';

type DriveEmailCollaboratorsProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

function fileNameWithoutExtension(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

export function DriveEmailCollaborators({path, open, onOpenChange}: DriveEmailCollaboratorsProps) {
    const [subject, setSubject] = useState('');
    const [message, setMessage] = useState('');
    const [sendCopyToSelf, setSendCopyToSelf] = useState(true);
    const emailMutation = useEmailCollaborators(path.ownerId, path.mountId);

    useEffect(() => {
        if (open) {
            setSubject(fileNameWithoutExtension(path.name));
            setMessage('');
            setSendCopyToSelf(true);
        }
    }, [open, path.name]);

    const handleSend = () => {
        const documentUrl = getDocumentUrl(path);
        if (!documentUrl) return;

        emailMutation.mutate(
            {
                pathId: path.id,
                subject,
                message,
                documentUrl,
                sendCopyToSelf,
            },
            {
                onSuccess: () => onOpenChange(false),
            },
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>Email collaborators</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="email-subject">Subject</Label>
                        <Input
                            id="email-subject"
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                            maxLength={200}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="email-message">Message</Label>
                        <Textarea
                            id="email-message"
                            autoFocus
                            placeholder="Write a message..."
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            className="min-h-[100px] resize-none"
                            maxLength={5000}
                        />
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
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={emailMutation.isPending}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSend}
                        disabled={!subject.trim() || !message.trim() || emailMutation.isPending}
                    >
                        {emailMutation.isPending ? 'Sending...' : 'Send'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
