import { createFileRoute } from '@tanstack/react-router';
import { ProfileEditor } from '../components/space/profile-editor';

export const Route = createFileRoute('/_auth/user')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <div className="flex flex-col m-8">
            <div className="w-full max-w-3xl">
                <h1 className="text-2xl font-semibold mb-6">Edit Profile</h1>
                <ProfileEditor />
            </div>
        </div>
    );
}
