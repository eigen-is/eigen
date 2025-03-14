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
    const [showMore, setShowMore] = React.useState(false);
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
            <div className="text-lg text-center mb-8 max-w-md">
                <div className={`transition-all duration-500 linear overflow-hidden`}>
                    <p className="mb-4">
                        Your personal workspace in the cloud.
                        <br />
                        Simple and secure. You control your own data.
                    </p>
                </div>
                <div
                    className={`transition-all duration-500 linear overflow-hidden ${
                        showMore ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'
                    }`}
                >
                    <p className="mb-4 text-center">
                        It includes mail, calendar, docs, drive and more — everything you need, nothing you don't.
                    </p>
                    <div className="flex justify-center w-full">
                        <div className="text-left">
                            <p className="mb-2">Store your data where you want:</p>
                            <ul className="list-disc pl-6 text-sm">
                                <li>Host with eigen.is — simple and secure by default</li>
                                <li>Connect your preferred cloud storage</li>
                                <li>Self-host on your own infrastructure</li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
            <div className="flex gap-4">
                <Button className="px-8 py-2 font-medium">
                    Login
                </Button>
                <Button variant="outline" className="px-6 py-2">
                    Join Waitlist
                </Button>
            </div>
            <div className="flex justify-center">
                <button
                    onClick={() => setShowMore(!showMore)}
                    className="text-blue-600 hover:text-blue-800 underline text-sm mt-4"
                >
                    {showMore ? 'Show less' : 'Learn more'}
                </button>
            </div>
        </div>
    );
}
