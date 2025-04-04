import {createFileRoute} from '@tanstack/react-router'
import {Shovel} from 'lucide-react'
import {apps} from "@workspace/lib/apps.ts"
import {Card, CardContent} from "@workspace/ui/components/card"

export const Route = createFileRoute('/_auth/')({
    component: HomeComponent,
})

interface AppItem {
    name: string;
    className: string;
    href: string | undefined;
    icon: string;
}

function HomeComponent() {
    return (
        <div className="flex flex-col flex-1 min-h-[calc(100vh-3.5rem)] h-full overflow-auto">

            <div className="flex-grow flex flex-col items-center justify-center w-full px-4 py-8">
                {/* Welcome Header */}
                <div className="text-5xl mb-6">
                    <span className="font-bold text-teal-600">eigen</span>
                </div>

                {/* Main tagline */}
                <div className="text-xl text-center mb-10">
                    <p className="mb-4">
                        Your personal workspace in the cloud.
                        <br/>
                        Simple and secure. You control your own data.
                    </p>
                </div>

                {/* Apps Grid */}
                <div className="max-w-4xl mx-auto w-full overflow-auto">
                    <h2 className="text-2xl font-semibold mb-6 text-center">Your Applications</h2>
                    <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
                        {apps.map((app: AppItem) => (
                            <Card key={app.name} className="overflow-hidden hover:shadow-md transition-shadow">
                                <CardContent className="p-0">
                                    <a href={app.href || '#'} className="block p-3 md:p-6">
                                        <div className="flex items-center gap-2 md:gap-3">
                                            <div className={`p-2 rounded-md ${app.className} bg-opacity-10`}>
                                                <span className={`${app.className}`} aria-hidden="true">
                                                    <svg
                                                        xmlns="http://www.w3.org/2000/svg"
                                                        width="20"
                                                        height="20"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        className="md:w-6 md:h-6"
                                                    >
                                                        <path d="m9 7-5 5 5 5"></path>
                                                        <path d="m15 7 5 5-5 5"></path>
                                                    </svg>
                                                </span>
                                            </div>
                                            <div>
                                                <h3 className={`font-medium ${app.className} text-sm md:text-base`}>{app.name}</h3>
                                                <p className="text-xs text-gray-500 hidden md:block">Access
                                                    your {app.name.toLowerCase()}</p>
                                            </div>
                                        </div>
                                    </a>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>
            </div>

            {/* Footer with European initiative */}
            <div className="text-center text-sm text-gray-500 py-4 border-t w-full bg-white">
                <div className="flex items-center justify-center mb-2">
                    <Shovel className="w-5 h-5 mr-2 text-yellow-600" aria-hidden="true"/>
                    <span className="font-medium">Under Construction</span>
                </div>
                <p>
                    eigen is made and hosted in the European Union.
                    Our goal is to quickly deliver a Minimum Viable Product and scale up afterwards.
                </p>
            </div>
        </div>
    );
}
