import { createFileRoute } from '@tanstack/react-router';
import { API_HOST, DAV_HOST, SERVER_HOSTNAME } from '@workspace/lib/api';
import { useAppPasswords, useAuth, useCreateAppPassword, useDeleteAppPassword } from '@workspace/lib/auth';
import { formatDate } from '@workspace/lib/date';
import { useMounts } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import { Column, ColumnLayout, CopyInput, ToolbarTitle } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Separator } from '@workspace/ui/components/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table';
import { Calendar, FolderTree, KeyRound, Mail, Plus, Trash2, UsersRound } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/_auth/services')({
    component: ServicesComponent,
});

function AppPasswords() {
    const { data: passwords, isLoading } = useAppPasswords();
    const createMutation = useCreateAppPassword();
    const deleteMutation = useDeleteAppPassword();
    const [name, setName] = useState('');
    const [newKey, setNewKey] = useState<string | null>(null);

    const handleCreate = async () => {
        if (!name.trim()) return;
        const result = await createMutation.mutateAsync(name.trim());
        if (result?.key) {
            setNewKey(result.key);
            setName('');
        }
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

                <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1">
                        <Label className="text-muted-foreground text-xs">Name</Label>
                        <Input
                            placeholder="e.g. Thunderbird"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                        />
                    </div>
                    <Button onClick={handleCreate} disabled={!name.trim() || createMutation.isPending}>
                        <Plus className="h-4 w-4 mr-1" />
                        Generate
                    </Button>
                </div>

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
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                                onClick={() => deleteMutation.mutate(pw.id)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function ServicesComponent() {
    const { user } = useAuth();
    const host = SERVER_HOSTNAME;
    const davBase = DAV_HOST;
    const webdavBase = `${API_HOST}/webdav`;
    const { data: personalMounts } = useMounts(user?.id ?? '');
    const { data: teams } = useMyTeams();

    return (
        <ColumnLayout>
            <Column id="detail" width="flex" onBack="sidebar" toolbar={<ToolbarTitle>Integrations</ToolbarTitle>}>
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl app-gutter">
                        <p className="text-sm text-muted-foreground mb-6">
                            Connect your calendars, contacts, mail, and drive to external clients like Thunderbird,
                            Apple Mail, Finder, rclone, or any app that supports CalDAV, CardDAV, IMAP, or WebDAV.
                        </p>

                        <div className="space-y-6">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Calendar className="h-5 w-5" />
                                        CalDAV (Calendar sync)
                                    </CardTitle>
                                    <CardDescription>
                                        Use these settings to sync your Eigen calendars with an external calendar app.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <CopyInput label="Server URL" value={`${davBase}/`} />
                                    <CopyInput
                                        label="Server URL (Thunderbird)"
                                        value={`${davBase}/calendars/${user?.id}/`}
                                    />
                                    <CopyInput label="Username" value={user?.email ?? ''} />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <UsersRound className="h-5 w-5" />
                                        CardDAV (Contacts sync)
                                    </CardTitle>
                                    <CardDescription>
                                        Use these settings to sync your Eigen contacts with an external contacts app.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <CopyInput label="Server URL" value={`${davBase}/`} />
                                    <CopyInput
                                        label="Server URL (address book)"
                                        value={`${davBase}/addressbooks/${user?.id}/`}
                                    />
                                    <CopyInput label="Username" value={user?.email ?? ''} />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Mail className="h-5 w-5" />
                                        IMAP (Email sync)
                                    </CardTitle>
                                    <CardDescription>
                                        Use these settings to access your Eigen mailbox from an external email client.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="grid grid-cols-2 gap-3">
                                    <CopyInput label="IMAP server" value={host} />
                                    <CopyInput label="IMAP Port" value="993" />
                                    <CopyInput label="Security" value="SSL/TLS" />
                                    <CopyInput label="Username" value={user?.email ?? ''} />
                                    <CopyInput label="SMTP server" value={host} />
                                    <CopyInput label="SMTP port" value="465" />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <FolderTree className="h-5 w-5" />
                                        WebDAV (Drive sync)
                                    </CardTitle>
                                    <CardDescription>
                                        Mount each drive separately in Finder, Explorer, rclone, DAVx5, or Mountain
                                        Duck. Authenticate with an app password generated below.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <CopyInput label="Username" value={user?.email ?? ''} />
                                    {personalMounts?.map((m) => (
                                        <CopyInput
                                            key={m.id}
                                            label={`Personal — ${m.name}`}
                                            value={`${webdavBase}/${user?.id ?? ''}/${m.id}/`}
                                        />
                                    ))}
                                    {teams?.flatMap((team) =>
                                        team.mounts.map((m) => (
                                            <CopyInput
                                                key={`${team.id}-${m.id}`}
                                                label={`${team.name} — ${m.name}`}
                                                value={`${webdavBase}/${teamOwnerId(team.id)}/${m.id}/`}
                                            />
                                        )),
                                    )}
                                </CardContent>
                            </Card>

                            <AppPasswords />
                        </div>
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
