// Space's Integrations page: the addresses and usernames that connect a calendar, contacts or mail app to Eigen,
// and the app passwords those apps sign in with.

import { createFileRoute } from '@tanstack/react-router';
import { API_HOST, DAV_HOST, SERVER_HOSTNAME } from '@workspace/lib/api';
import { useCalendars } from '@workspace/lib/calendar';
import { useMounts } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { useMailEnabled } from '@workspace/lib/public';
import { teamOwnerId } from '@workspace/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { CopyInput } from '@workspace/ui/components/copy-input';
import { SettingsPage } from '@workspace/ui/components/layout/app';
import { Calendar, FolderTree, Mail, UsersRound } from 'lucide-react';
import { AppPasswords } from '../components/space/app-passwords';

export const Route = createFileRoute('/_auth/services')({
    component: ServicesComponent,
});

function ServicesComponent() {
    const { user } = Route.useRouteContext();
    const mailEnabled = useMailEnabled();
    const webdavBase = `${API_HOST}/webdav`;
    const { data: personalMounts } = useMounts(user.id);
    // CalDAV serves the viewer's own calendars only, so the per-calendar addresses list no shared or team calendar.
    const { data: calendars } = useCalendars(user.id);
    const { data: teams } = useMyTeams();

    return (
        <SettingsPage title="Integrations">
            <p className="text-sm text-muted-foreground mb-6">
                {mailEnabled
                    ? 'Connect your calendars, contacts, mail, and drive to external clients like Thunderbird, Apple Mail, Finder, rclone, or any app that supports CalDAV, CardDAV, IMAP, or WebDAV.'
                    : 'Connect your calendars, contacts, and drive to external clients like Thunderbird, Finder, rclone, or any app that supports CalDAV, CardDAV, or WebDAV.'}
            </p>

            <div className="space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Calendar className="h-5 w-5" />
                            CalDAV (Calendar sync)
                        </CardTitle>
                        <CardDescription>
                            Use these settings to sync your Eigen calendars with an external calendar app. A client that
                            subscribes to one calendar at a time takes that calendar's own address.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <CopyInput label="Server URL" value={`${DAV_HOST}/`} />
                        <CopyInput label="Server URL (Thunderbird)" value={`${DAV_HOST}/calendars/${user.id}/`} />
                        {calendars?.map((cal) => (
                            <CopyInput
                                key={cal.id}
                                label={`Calendar — ${cal.name}`}
                                value={`${DAV_HOST}/calendars/${user.id}/${encodeURIComponent(cal.id)}/`}
                            />
                        ))}
                        <CopyInput label="Username" value={user.email} />
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
                        <CopyInput label="Server URL" value={`${DAV_HOST}/`} />
                        <CopyInput label="Server URL (address book)" value={`${DAV_HOST}/addressbooks/${user.id}/`} />
                        <CopyInput label="Username" value={user.email} />
                    </CardContent>
                </Card>

                {mailEnabled && (
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
                            <CopyInput label="IMAP server" value={SERVER_HOSTNAME} />
                            <CopyInput label="IMAP port" value="993" />
                            <CopyInput label="Security" value="SSL/TLS" />
                            <CopyInput label="Username" value={user.email} />
                            <CopyInput label="SMTP server" value={SERVER_HOSTNAME} />
                            <CopyInput label="SMTP port" value="465" />
                        </CardContent>
                    </Card>
                )}

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <FolderTree className="h-5 w-5" />
                            WebDAV (Drive sync)
                        </CardTitle>
                        <CardDescription>
                            Mount each drive separately in Finder, Explorer, rclone, DAVx5, or Mountain Duck.
                            Authenticate with an app password generated below.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <CopyInput label="Username" value={user.email} />
                        {personalMounts?.map((m) => (
                            <CopyInput
                                key={m.id}
                                label={`Personal — ${m.name}`}
                                value={`${webdavBase}/${user.id}/${m.id}/`}
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
        </SettingsPage>
    );
}
