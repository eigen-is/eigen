import {createFileRoute, Link} from '@tanstack/react-router'

export const Route = createFileRoute('/')({
    component: HomeComponent,
})

function HomeComponent() {
    return (
        <div className="flex items-center justify-center h-full">
            <div className="text-center p-8 max-w-2xl">
                <h1 className="text-4xl font-bold mb-6">Welcome to EigenMail</h1>
                <p className="text-xl mb-6">
                    Your emails will appear here. Get started by checking your inbox.
                </p>
                <Link to='/inbox'>
                    Check Inbox
                </Link>
            </div>
        </div>
    )
}
