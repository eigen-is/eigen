import {createFileRoute} from '@tanstack/react-router'
import React from 'react';
import {Button} from "@workspace/ui/components/button";
import {apps} from "@workspace/lib/apps.ts";
import { Input } from "@workspace/ui/components/input";
import { Textarea } from "@workspace/ui/components/textarea";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Label } from '@workspace/ui/components/label';

export const Route = createFileRoute('/')({
    component: HomeComponent,
})

export function HomeComponent() {    
    const [appIndex, setAppIndex] = React.useState(0);
    const [showMore, setShowMore] = React.useState(false);
    const [showWaitlistForm, setShowWaitlistForm] = React.useState(false);
    const [email, setEmail] = React.useState("");
    const [notes, setNotes] = React.useState("");
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const app = apps[appIndex];
    
    React.useEffect(() => {
        const interval = setInterval(() => {
            setAppIndex((prevIndex) => (prevIndex + 1) % apps.length);
        }, 2000);
        
        return () => clearInterval(interval);
    }, [apps.length]);

    const handleLogin = () => {
        window.location.href = './mail/';
    };
    
    const handleShowWaitlistButton = () => {
        setShowWaitlistForm(true);
        setShowMore(false);
    };

    const handleWaitlistSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        
        // Simulate submission - in a real app, this would be an API call
        setTimeout(() => {
            setIsSubmitting(false);
            setShowWaitlistForm(false);
            // Reset form
            setEmail("");
            setNotes("");
        }, 1000);
    };

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
                    <div className="flex justify-center w-full">
                        <div className="text-left">
                            <p className="mb-2 text-center">Store your data where you want:</p>
                            <ul className="list-disc pl-6 text-sm">
                                <li>Host with eigen.is — simple and secure by default</li>
                                <li>Connect your preferred cloud storage</li>
                                <li>Self-host on your own infrastructure</li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
            
            {!showWaitlistForm ? (
                <>
                <div className="flex gap-4">
                    <Button className="px-8 py-2 font-medium flex-3" onClick={handleLogin}>
                        Login
                    </Button>
                    <Button 
                        variant="outline" 
                        className="px-6 py-2 flex-1"
                        onClick={handleShowWaitlistButton}
                    >
                        Join Waitlist
                    </Button>
                </div>
                <div className="flex justify-center mt-4">
                    <button
                        onClick={() => setShowMore(!showMore)}
                        className="text-blue-600 hover:text-blue-800 underline text-sm cursor-pointer"
                    >
                        {showMore ? 'Show less' : 'Learn more'}
                    </button>
                </div>
                </>
            ) : (
                <Card className="w-full max-w-md">
                    <CardHeader>
                        <CardTitle>Join the Waitlist <small>(Exclusive Access Only)</small></CardTitle>
                    </CardHeader>
                    <form onSubmit={handleWaitlistSubmit}>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="email">
                                    Email
                                </Label>
                                <Input
                                    id="email"
                                    type="email"
                                    placeholder="Enter your email"
                                    value={email}
                                    disabled={isSubmitting}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="notes">
                                    Notes (Optional)
                                </Label>
                                <Textarea
                                    id="notes"
                                    placeholder="Tell us why you're interested"
                                    value={notes}
                                    disabled={isSubmitting}
                                    onChange={(e) => setNotes(e.target.value)}
                                />
                            </div>
                        </CardContent>
                        <CardFooter className="flex justify-between mt-4 gap-2">
                            <Button 
                                type="button" 
                                variant="outline" 
                                className="flex-1"
                                disabled={isSubmitting}
                                onClick={() => setShowWaitlistForm(false)}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={isSubmitting} className="flex-3">
                                {isSubmitting ? "Submitting..." : "Submit"}
                            </Button>
                        </CardFooter>
                    </form>
                </Card>
            )}
            
        </div>
    );
}
