// The Email collaborators dialog: a message about one Drive file to everyone it is shared with. The server adds a link
// to the file. Drive's Share dialog and an editor's File menu open it, for example. The subject starts as the file's
// name, and the message starts as the user's first signature. Send stays disabled until the message says more than the
// signature. It is also disabled while the subject or the message is too long. Only a click on Send sends the email.

import { useEmailCollaborators } from '@workspace/lib/drive';
import { useSpaceSettings } from '@workspace/lib/space';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { LightEditor } from '@workspace/ui/components/editor/light-editor';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { useState } from 'react';
import { LoadingState } from '../layout/app/loading-state';

type DriveEmailCollaboratorsProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

const MESSAGE_TEXT_LIMIT = 10000;
const SUBJECT_LIMIT = 200;

export function DriveEmailCollaborators({ path, open, onOpenChange }: DriveEmailCollaboratorsProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Email collaborators" size="sm">
            <EmailCollaboratorsBody path={path} />
        </FormDialog>
    );
}

// The editor takes its content only when it mounts, so the form waits for the settings that hold the signature. Settings
// that fail to load leave the message empty.
function EmailCollaboratorsBody({ path }: { path: DrivePath }) {
    const { data: spaceSettings, isLoading } = useSpaceSettings();
    if (isLoading) {
        return (
            <FormDialogForm canSubmit={false} submitLabel="Send" onSubmit={() => {}}>
                <LoadingState />
            </FormDialogForm>
        );
    }
    return <EmailCollaboratorsForm path={path} signature={spaceSettings?.email?.signatures?.[0]?.html ?? ''} />;
}

// Mounted with the dialog, so each opening starts from the file's name and the signature.
function EmailCollaboratorsForm({ path, signature }: { path: DrivePath; signature: string }) {
    const defaultSubject = stripEigenExtension(path.name);
    const [subject, setSubject] = useState(defaultSubject);
    const [message, setMessage] = useState(signature);
    const [messageText, setMessageText] = useState('');
    // The editor's own text of the seeded signature, so a message that is only the signature can't be sent.
    const [seedText, setSeedText] = useState('');
    const [sendCopyToSelf, setSendCopyToSelf] = useState(true);
    const emailMutation = useEmailCollaborators(path.ownerId, path.mountId);

    const trimmedMessageText = messageText.trim();
    const hasContent = trimmedMessageText.length > 0 && trimmedMessageText !== seedText.trim();
    const overLimit = messageText.length > MESSAGE_TEXT_LIMIT;
    const subjectOverLimit = subject.length > SUBJECT_LIMIT;

    return (
        <FormDialogForm
            canSubmit={hasContent && !overLimit && !subjectOverLimit}
            submitLabel="Send"
            onSubmit={async () => {
                await emailMutation.mutateAsync({
                    pathId: path.id,
                    subject: subject.trim() || defaultSubject,
                    message,
                    sendCopyToSelf,
                });
            }}
        >
            <div className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="email-subject">Subject</Label>
                    <Input
                        id="email-subject"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        // An email can't be taken back, so Enter in the subject doesn't send it.
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') e.preventDefault();
                        }}
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
        </FormDialogForm>
    );
}
