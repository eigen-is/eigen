import { createFileRoute } from '@tanstack/react-router';
import { API_HOST } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import {
    useAppPasswords,
    useCreateAppPassword,
    useDeleteAppPassword,
} from '@workspace/lib/core/auth/hooks/use-app-passwords';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Separator } from '@workspace/ui/components/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table';
import { Calendar, Check, Copy, FolderTree, KeyRound, Mail, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/_auth/services')({
    component: ServicesComponent,
});

function CopyableField({ label, value }: { label: string; value: string }) {
    return (
        <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">{label}</Label>
            <Input readOnly value={value} className="font-mono text-sm" onClick={(e) => e.currentTarget.select()} />
        </div>
    );
}

function AppPasswords() {
    const { data: passwords, isLoading } = useAppPasswords();
    const createMutation = useCreateAppPassword();
    const deleteMutation = useDeleteAppPassword();
    const [name, setName] = useState('');
    const [newKey, setNewKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const handleCreate = async () => {
        if (!name.trim()) return;
        const result = await createMutation.mutateAsync(name.trim());
        if (result?.key) {
            setNewKey(result.key);
            setName('');
        }
    };

    const handleCopy = () => {
        if (newKey) {
            navigator.clipboard.writeText(newKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
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
                        <div className="flex items-center gap-2">
                            <Input
                                readOnly
                                value={newKey}
                                className="font-mono text-sm"
                                onClick={(e) => e.currentTarget.select()}
                            />
                            <Button variant="outline" size="icon" onClick={handleCopy}>
                                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                            </Button>
                        </div>
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
                                            {new Date(pw.createdAt).toLocaleDateString()}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">
                                            {pw.lastRequest ? new Date(pw.lastRequest).toLocaleDateString() : 'Never'}
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
    const host = new URL(API_HOST).hostname;
    const davBase = `${API_HOST}/dav`;
    const webdavBase = `${API_HOST}/webdav`;

    return (
        <div className="flex flex-col m-8">
            <div className="w-full max-w-3xl">
                <h1 className="text-2xl font-semibold mb-6">Integrations</h1>
                <p className="text-sm text-muted-foreground mb-6">
                    Connect your calendars, mail, and drive to external clients like Thunderbird, Apple Mail, Finder,
                    rclone, or any app that supports CalDAV, IMAP, or WebDAV.
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
                            <CopyableField label="Server URL" value={`${davBase}/`} />
                            <CopyableField
                                label="Server URL (Thunderbird)"
                                value={`${davBase}/calendars/${user?.id}/`}
                            />
                            <CopyableField label="Username" value={user?.email ?? ''} />
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
                            <CopyableField label="IMAP server" value={host} />
                            <CopyableField label="IMAP Port" value="993" />
                            <CopyableField label="Security" value="SSL/TLS" />
                            <CopyableField label="Username" value={user?.email ?? ''} />
                            <CopyableField label="SMTP server" value={host} />
                            <CopyableField label="SMTP port" value="465" />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <FolderTree className="h-5 w-5" />
                                WebDAV (Drive sync)
                            </CardTitle>
                            <CardDescription>
                                Mount your Eigen drive in Finder, Explorer, rclone, or Mountain Duck. Authenticate with
                                an app password generated below.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <CopyableField label="Server URL" value={`${webdavBase}/${user?.id ?? ''}/`} />
                            <CopyableField label="Username" value={user?.email ?? ''} />
                        </CardContent>
                    </Card>

                    <AppPasswords />
                </div>
            </div>
        </div>
    );
}
