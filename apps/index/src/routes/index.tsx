import {createFileRoute} from '@tanstack/react-router'
import React from 'react';
import {Button} from "@workspace/ui/components/ui/button";

export const Route = createFileRoute('/')({
    component: HomeComponent,
})

function HomeComponent() {
    const apps = [
        {
            name: 'Mail',
            className: 'text-red-600',
            href: '/mail',
        },
        {
            name: 'Calendar',
            className: 'text-blue-600',
            href: '/calendar',
        },
        {
            name: 'Contacts',
            className: 'text-green-600',
            href: '/contacts',
        },
        {
            name: 'Drive',
            className: 'text-yellow-600',
            href: '/drive',
        },
        {
            name: 'Docs',
            className: 'text-purple-600',
            href: '/docs',
        },
    ];
    
    const [appIndex, setAppIndex] = React.useState(0);
    const app = apps[appIndex];
    
    React.useEffect(() => {
        const interval = setInterval(() => {
            setAppIndex((prevIndex) => (prevIndex + 1) % apps.length);
        }, 2000);
        
        return () => clearInterval(interval);
    }, [apps.length]);

    return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4">
            <div className="text-5xl mb-8">
                <span className={`font-bold ${app.className}`}>eigen</span>
                <span className={app.className}>|{app.name.toLowerCase()}&gt;</span>
            </div>
            <p className="text-lg text-center mb-8 max-w-md">
                Your personal workspace in the cloud.
                <br />
                Simple, secure, and always available.
            </p>
            <div className="flex gap-4">
                <Button className="px-8 py-2 font-medium">
                    Login
                </Button>
                <Button variant="outline" className="px-6 py-2">
                    Join Waitlist
                </Button>
            </div>
        </div>
    );
}
