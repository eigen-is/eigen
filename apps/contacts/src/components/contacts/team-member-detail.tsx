import { getMailComposeUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useStartChatWith } from '@workspace/lib/chat';
import { Toolbar, TooltipButton } from '@workspace/ui';
import { ChatCreateWizard } from '@workspace/ui/components/layout/chat/chat-create-wizard';
import { UserDetailHero } from '@workspace/ui/components/layout/user-detail-hero';
import { Mail, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import type { TeamMember } from './team-member-list';

// Team members always resolve to an Eigen user, so the action is unconditional here (unlike personal
// contacts, which gate on eigenId in ContactDetailToolbar) — except on your own row, where there is
// no one to chat with.
export function TeamMemberDetailToolbar({ member }: { member: TeamMember }) {
    const { user } = useAuth();
    const startChatWith = useStartChatWith();
    const [chatOpen, setChatOpen] = useState(false);

    const isSelf = member.email.toLowerCase() === (user?.email ?? '').toLowerCase();

    const handleStartChat = async () => {
        // 'opened' means an existing writable 1:1 was navigated to; otherwise open the wizard pre-filled.
        if ((await startChatWith(member.email)) !== 'opened') setChatOpen(true);
    };

    return (
        <>
            <Toolbar>
                <div className="flex items-center gap-1 ml-auto">
                    {!isSelf && (
                        <TooltipButton
                            icon={MessageSquare}
                            tooltipText="Start chat"
                            className="h-8 w-8"
                            onClick={() => void handleStartChat()}
                        />
                    )}
                </div>
            </Toolbar>
            <ChatCreateWizard
                open={chatOpen}
                onOpenChange={setChatOpen}
                initialPeople={[{ email: member.email, name: member.name }]}
            />
        </>
    );
}

type TeamMemberDetailProps = {
    member: TeamMember;
};

export function TeamMemberDetail({ member }: TeamMemberDetailProps) {
    return (
        <div className="h-full flex flex-col overflow-hidden">
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
