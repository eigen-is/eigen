import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { ProfileEditor } from '../components/space/profile-editor';

export const Route = createFileRoute('/_auth/user')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <ColumnLayout>
            <Column
                id="detail"
                width="flex"
                toolbar={<span className="text-sm text-foreground font-normal">Edit Profile</span>}
            >
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl p-8">
                        <ProfileEditor />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
