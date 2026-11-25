// The App passwords card on Space's Integrations page: the passwords an external client such as Thunderbird signs in
// with, a form that generates a new one and shows it once, and a delete that asks first, since a deleted password
// can't be brought back and every client using it stops signing in.

import { useAppPasswords, useCreateAppPassword, useDeleteAppPassword } from '@workspace/lib/auth';
import { formatDate } from '@workspace/lib/date';
import { FIELD_MESSAGES } from '@workspace/lib/validation';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { CopyInput } from '@workspace/ui/components/copy-input';
import { FormShell } from '@workspace/ui/components/form-shell';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import { Separator } from '@workspace/ui/components/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

export function AppPasswords() {
    const { data: passwords, isLoading } = useAppPasswords();
    const createAppPassword = useCreateAppPassword();
    const deleteAppPassword = useDeleteAppPassword();
    const { pending, run } = useDialogPending();
    const deleteDialog = useDialogValue<{ id: string; name: string }>();
    const deleting = deleteDialog.value;
    const [name, setName] = useState('');
    const [newKey, setNewKey] = useState<string | null>(null);

    const handleCreate = async () => {
        if (!name.trim()) return false;
        const { key } = await createAppPassword.mutateAsync(name.trim());
        setNewKey(key);
        setName('');
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <KeyRound className="h-5 w-5" />
                    App passwords
                </CardTitle>
                <CardDescription>
                    App passwords let you connect external clients like Thunderbird without exposing your main password.
                    Required when two-factor authentication is enabled.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {newKey && (
                    <div className="rounded-md border bg-accent text-accent-foreground p-4 space-y-2">
                        <p className="text-sm font-medium">
                            Copy this password now. You won't be able to see it again.
                        </p>
                        <CopyInput value={newKey} successMessage="App password copied to clipboard" />
                        <Button variant="outline" size="sm" onClick={() => setNewKey(null)}>
                            Done
                        </Button>
                    </div>
                )}

                <FormShell className="flex items-start gap-2" onSubmit={() => run(handleCreate)}>
                    <RequiredTextField
                        label="Name"
                        placeholder="e.g. Thunderbird"
                        value={name}
                        onChange={setName}
                        message={FIELD_MESSAGES.nameMissing}
                        className="flex-1 gap-1"
                    />
                    <Button type="submit" className="mt-6" pending={pending}>
                        <Plus className="h-4 w-4 mr-1" />
                        Generate
                    </Button>
                </FormShell>

                {!isLoading && passwords && passwords.length > 0 && (
                    <>
                        <Separator />
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Created</TableHead>
                                    <TableHead>Last used</TableHead>
                                    <TableHead className="w-10" />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {passwords.map((pw) => (
                                    <TableRow key={pw.id}>
                                        <TableCell className="font-medium">{pw.name ?? 'Unnamed'}</TableCell>
                                        <TableCell className="text-muted-foreground">
                                            {formatDate(pw.createdAt)}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">
                                            {pw.lastRequest ? formatDate(pw.lastRequest) : 'Never'}
                                        </TableCell>
                                        <TableCell>
                                            <TooltipButton
                                                icon={Trash2}
                                                tooltipText="Delete"
                                                onClick={() =>
                                                    deleteDialog.openDialog({ id: pw.id, name: pw.name ?? 'Unnamed' })
                                                }
                                            />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </>
                )}
            </CardContent>

            {deleting && (
                <ConfirmDialog
                    open={deleteDialog.open}
                    onOpenChange={deleteDialog.setOpen}
                    title="Delete app password"
                    description={
                        <>
                            Delete the app password <strong>{deleting.name}</strong>? Apps that sign in with it stop
                            working.
                        </>
                    }
                    onConfirm={async () => {
                        await deleteAppPassword.mutateAsync(deleting.id);
                    }}
                    confirmText="Delete"
                    destructive
                />
            )}
        </Card>
    );
}
