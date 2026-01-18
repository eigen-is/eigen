import {createFileRoute} from '@tanstack/react-router'

export const Route = createFileRoute('/_auth/dashboard')({
    component: AdminDashboard,
})

function AdminDashboard() {
    return (
        <div className="flex flex-col h-full p-6 overflow-auto">
            <div className="max-w-6xl mx-auto w-full space-y-6">
                <div>
                    <h1 className="text-3xl font-bold mb-2">Admin Dashboard</h1>
                    <p className="text-muted-foreground">Manage your Eigen instance</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-card rounded-lg border p-6">
                        <h3 className="text-lg font-semibold mb-2">Users</h3>
                        <p className="text-3xl font-bold text-app">0</p>
                        <p className="text-sm text-muted-foreground mt-2">Total users</p>
                    </div>
                    <div className="bg-card rounded-lg border p-6">
                        <h3 className="text-lg font-semibold mb-2">Storage</h3>
                        <p className="text-3xl font-bold text-app">0 GB</p>
                        <p className="text-sm text-muted-foreground mt-2">Used space</p>
                    </div>
                    <div className="bg-card rounded-lg border p-6">
                        <h3 className="text-lg font-semibold mb-2">System</h3>
                        <p className="text-3xl font-bold text-app">Active</p>
                        <p className="text-sm text-muted-foreground mt-2">Status</p>
                    </div>
                </div>

                <div className="bg-card rounded-lg border p-6">
                    <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
                    <p className="text-muted-foreground">
                        User management and other admin features will be available here.
                    </p>
                </div>
            </div>
        </div>
    )
}
