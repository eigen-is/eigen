import { createFileRoute } from '@tanstack/react-router';
import { API_HOST } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Calendar, Mail } from 'lucide-react';

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

function ServicesComponent() {
    const { user } = useAuth();
    const host = new URL(API_HOST).hostname;
    const davBase = `${API_HOST}/dav`;

    return (
        <div className="flex flex-col m-8">
            <div className="w-full max-w-3xl">
                <h1 className="text-2xl font-semibold mb-6">Calendar & Mail</h1>
                <p className="text-sm text-muted-foreground mb-6">
                    Connect your calendars and email to external clients like Thunderbird, Apple Mail, or any app that
                    supports CalDAV and IMAP.
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
                </div>
            </div>
        </div>
    );
}
