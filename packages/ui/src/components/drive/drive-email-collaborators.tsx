// The Email collaborators dialog: a message about one Drive file to everyone it is shared with. The server adds a link
// to the file. Drive's Share dialog and an editor's File menu open it, for example. The subject starts as the file's
// name, and the message starts as the user's first signature. A message that says no more than the signature, or one
// past the limit, is refused with its reason under the message. Send or Cmd+Enter sends the email, and plain Enter
// never does.

import { useEmailCollaborators } from '@workspace/lib/drive';
import { useSpaceSettings } from '@workspace/lib/space';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { LightEditor } from '@workspace/ui/components/editor/light-editor';
import { Field, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { useId, useState } from 'react';
import { LoadingState } from '../layout/app/loading-state';

type DriveEmailCollaboratorsProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

const MESSAGE_TEXT_LIMIT = 10000;
// The field itself stops a longer subject.
const SUBJECT_LIMIT = 200;

export function DriveEmailCollaborators({ path, open, onOpenChange }: DriveEmailCollaboratorsProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Email collaborators">
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
            <FormDialogForm readOnly changed={false} submitLabel="Send" onSubmit={() => {}}>
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

    return (
        <FormDialogForm
            changed={subject !== defaultSubject || hasContent || !sendCopyToSelf}
            submitLabel="Send"
            onSubmit={async () => {
                if (!hasContent || overLimit) return false;
                await emailMutation.mutateAsync({
                    pathId: path.id,
                    subject: subject.trim() || defaultSubject,
                    message,
                    sendCopyToSelf,
                });
            }}
        >
            <Field>
                <FieldLabel htmlFor="email-subject">Subject</FieldLabel>
                <Input
                    id="email-subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    // An email can't be taken back, so plain Enter in the subject doesn't send it. Cmd+Enter does.
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                    }}
                    maxLength={SUBJECT_LIMIT}
                />
            </Field>
            <MessageField
                content={message}
                onChange={setMessage}
                onChangeText={setMessageText}
                onReady={setSeedText}
                length={messageText.length}
                empty={!hasContent}
            />
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
            <p className="text-xs text-muted-foreground">A link to the document will be included in the message</p>
        </FormDialogForm>
    );
}

// Inside the form, so it reads whether Send was pressed: a message with nothing of its own is red only after that, and
// one past the limit at once. The editor scrolls inside its box, so a long message keeps the counter and Send in view.
function MessageField({
    content,
    onChange,
    onChangeText,
    onReady,
    length,
    empty,
}: {
    content: string;
    onChange: (html: string) => void;
    onChangeText: (text: string) => void;
    onReady: (text: string) => void;
    length: number;
    empty: boolean;
}) {
    const labelId = useId();
    const errorId = useId();
    const submitted = useFormSubmitted();
    const error =
        length > MESSAGE_TEXT_LIMIT
            ? `Shorten the message to ${MESSAGE_TEXT_LIMIT.toLocaleString()} characters`
            : submitted && empty
              ? 'Add a message'
              : undefined;
    return (
        <Field>
            <FieldLabel id={labelId}>Message</FieldLabel>
            <div className="max-h-[40vh] overflow-y-auto rounded-md border">
                <LightEditor
                    content={content}
                    onChange={onChange}
                    onChangeText={onChangeText}
                    onReady={({ text }) => onReady(text)}
                    labelledBy={labelId}
                    errorId={error ? errorId : undefined}
                    submitOnModEnter
                    placeholder="Write a message..."
                    className="px-3 py-2"
                    containerClassName="min-h-[180px] flex flex-col"
                />
            </div>
            <div className="flex justify-between gap-2 text-xs">
                {error ? <FieldError id={errorId}>{error}</FieldError> : <span />}
                <span className="text-muted-foreground">
                    {length.toLocaleString()}/{MESSAGE_TEXT_LIMIT.toLocaleString()}
                </span>
            </div>
        </Field>
    );
}
