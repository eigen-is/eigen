// The App passwords card on Space's Integrations page: the passwords an external client such as Thunderbird signs in
// with, and a form that generates a new one and shows it once.

import { useAppPasswords, useCreateAppPassword, useDeleteAppPassword } from '@workspace/lib/auth';
import { formatDate } from '@workspace/lib/date';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { CopyInput } from '@workspace/ui/components/copy-input';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Separator } from '@workspace/ui/components/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

export function AppPasswords() {
    const { data: passwords, isLoading } = useAppPasswords();
    const createMutation = useCreateAppPassword();
    const deleteMutation = useDeleteAppPassword();
    const [name, setName] = useState('');
    const [newKey, setNewKey] = useState<string | null>(null);

    const handleCreate = () => {
        if (!name.trim()) return;
        createMutation.mutate(name.trim(), {
            onSuccess: (result) => {
                if (!result.key) return;
                setNewKey(result.key);
                setName('');
            },
        });
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
                                            <TooltipButton
                                                icon={Trash2}
                                                tooltipText="Delete"
                                                onClick={() => deleteMutation.mutate(pw.id)}
                                            />
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
