import { getMailComposeUrl } from '@workspace/lib/api';
import { Toolbar, UserAvatar } from '@workspace/ui';
import { Mail } from 'lucide-react';

type TeamMember = { email: string; name: string };

export function TeamMemberDetailToolbar() {
    return <Toolbar />;
}

type TeamMemberDetailProps = {
    member: TeamMember;
};

export function TeamMemberDetail({ member }: TeamMemberDetailProps) {
    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto p-6">
                <div className="flex flex-col md:flex-row gap-8">
                    <div className="flex flex-col items-center gap-4 w-50">
                        <div className="h-40 w-40">
                            <UserAvatar name={member.name} email={member.email} className="h-full w-full" size="lg" />
                        </div>
                        <div className="text-center">
                            <h2 className="text-2xl font-bold">{member.name}</h2>
                        </div>
                    </div>

                    <div className="flex-1 space-y-6">
                        <div className="space-y-4">
                            <h3 className="text-lg font-semibold border-b pb-2">Contact Information</h3>
                            <div className="space-y-2">
                                <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                    <Mail className="h-4 w-4" />
                                    Email
                                </h4>
                                <div className="pl-6">
                                    <a className="text-primary hover:underline" href={getMailComposeUrl(member.email)}>
                                        {member.email}
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
