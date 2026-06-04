import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { ProfileEditor } from '../components/space/profile-editor';

export const Route = createFileRoute('/_auth/user')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex" toolbar={<ToolbarTitle>Edit Profile</ToolbarTitle>}>
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl p-8">
                        <ProfileEditor />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
