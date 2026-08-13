import { useEmailCollaborators } from '@workspace/lib/drive';
import { useSpaceSettings } from '@workspace/lib/space';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { LightEditor } from '@workspace/ui/components/editor/light-editor';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { useEffect, useState } from 'react';

type DriveEmailCollaboratorsProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

const MESSAGE_TEXT_LIMIT = 10000;
const SUBJECT_LIMIT = 200;

export function DriveEmailCollaborators({ path, open, onOpenChange }: DriveEmailCollaboratorsProps) {
    const defaultSubject = stripEigenExtension(path.name);
    const { data: spaceSettings } = useSpaceSettings();
    const signatureHtml = spaceSettings?.email?.signatures?.[0]?.html ?? '';

    const [subject, setSubject] = useState(defaultSubject);
    const [message, setMessage] = useState(signatureHtml);
    const [messageText, setMessageText] = useState('');
    // Canonical text of the seeded signature, captured from LightEditor's onReady.
    // Used to detect whether the user has actually typed something — otherwise an
    // unedited signature would count as "non-empty" and let Send fire.
    const [seedText, setSeedText] = useState('');
    const [sendCopyToSelf, setSendCopyToSelf] = useState(true);
    const emailMutation = useEmailCollaborators(path.ownerId, path.mountId);

    useEffect(() => {
        if (open) {
            setSubject(defaultSubject);
            setMessage(signatureHtml);
            setMessageText('');
            setSeedText('');
            setSendCopyToSelf(true);
        }
    }, [open, defaultSubject, signatureHtml]);

    const handleSend = () => {
        emailMutation.mutate(
            {
                pathId: path.id,
                subject: subject.trim() || defaultSubject,
                message,
                sendCopyToSelf,
            },
            {
                onSuccess: () => onOpenChange(false),
            },
        );
    };

    const trimmedMessageText = messageText.trim();
    const hasContent = trimmedMessageText.length > 0 && trimmedMessageText !== seedText.trim();
    const overLimit = messageText.length > MESSAGE_TEXT_LIMIT;
    const subjectOverLimit = subject.length > SUBJECT_LIMIT;

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
                            maxLength={SUBJECT_LIMIT}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label>Message</Label>
                        <div className="rounded-md border">
                            <LightEditor
                                content={message}
                                onChange={setMessage}
                                onChangeText={setMessageText}
                                onReady={({ text }) => setSeedText(text)}
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
                    <Button
                        onClick={handleSend}
                        disabled={!hasContent || overLimit || subjectOverLimit || emailMutation.isPending}
                    >
                        {emailMutation.isPending ? 'Sending...' : 'Send'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
