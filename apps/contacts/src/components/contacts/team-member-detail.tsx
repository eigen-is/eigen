import { getMailComposeUrl } from '@workspace/lib/api';
import { UserDetailHero } from '@workspace/ui/components/layout/user-detail-hero';
import { Mail } from 'lucide-react';
import { PersonDetailToolbar } from './person-detail-toolbar';
import type { TeamMember } from './team-member-list';

// Team members aren't editable contact rows — the shared toolbar disables Edit/Delete.
export function TeamMemberDetailToolbar({ member }: { member: TeamMember }) {
    return <PersonDetailToolbar name={member.name} emails={[member.email]} />;
}

type TeamMemberDetailProps = {
    member: TeamMember;
};

export function TeamMemberDetail({ member }: TeamMemberDetailProps) {
    return (
        <div className="h-full flex flex-col overflow-hidden" data-document="team-member-detail">
            <div className="flex-1 overflow-auto app-gutter">
                <div className="flex flex-col md:flex-row gap-8">
                    <UserDetailHero layout="profile" name={member.name} email={member.email} />

                    <div className="flex-1 space-y-6">
                        <div className="space-y-4">
                            <h3 className="text-lg font-medium border-b pb-2">Contact Information</h3>
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
