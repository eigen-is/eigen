import {createFileRoute, Link} from '@tanstack/react-router'
import React, {useCallback} from 'react';
import {Button} from "@workspace/ui/components/button";
import {apps} from "@workspace/lib/apps";
import {Input} from "@workspace/ui/components/input";
import {Textarea} from "@workspace/ui/components/textarea";
import {Card, CardContent, CardFooter, CardHeader, CardTitle} from "@workspace/ui/components/card";
import {Label} from '@workspace/ui/components/label';
import {spaceApi} from '@workspace/lib/api';
import {toast} from "sonner";

export const Route = createFileRoute('/')({
    component: HomeComponent,
})

export function HomeComponent() {
    const [appIndex, setAppIndex] = React.useState(0);
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

    const resetForm = useCallback(() => {
        setIsSubmitting(false);
        setShowWaitlistForm(false);
        setEmail("");
        setNotes("");
    }, []);

    const handleLogin = useCallback(() => {
        window.location.href = './space/';
    }, []);

    const handleShowWaitlist = useCallback(() => {
        setShowWaitlistForm(true);
    }, []);

    const handleWaitlistSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);

        const time = new Date().getTime();
        const waitlistResult = await spaceApi.waitlist.post({email, notes});
        const duration = new Date().getTime() - time;
        // Make sure it takes a bit
        await new Promise(resolve => setTimeout(resolve, Math.max(350 - duration, 0)));

        resetForm();

        const isSignedUp = waitlistResult.data === true;
        if (isSignedUp) {
            toast.success('Joined the waitlist', {description: 'Thanks for signing up'});
        } else {
            toast.error('Failed to sign up', {description: 'Signing up currently not available, please try again'});
        }

    }, [spaceApi.waitlist]);

    return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4">
            <div className="text-5xl mb-8">
                <span className={`font-bold ${app.className}`}>eigen</span>
                <span className={app.className}>|{app.name.toLowerCase()}&gt;</span>
            </div>
            <div className="text-lg text-center mb-8 max-w-md">
                <div>
                    <p className="mb-4">
                        Your personal workspace in the cloud.
                        <br/>
                        Simple and secure. You control your data.
                    </p>
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
                            onClick={handleShowWaitlist}
                        >
                            Join Waitlist
                        </Button>
                    </div>
                    <div className="flex justify-center mt-4">
                        <Link
                            to="/blog"
                            className="text-blue-600 hover:text-blue-800 underline text-sm"
                        >
                            Learn more
                        </Link>
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
                        <CardFooter className="flex justify-end mt-4 gap-4">
                            <Button
                                type="button"
                                variant="outline"
                                disabled={isSubmitting}
                                onClick={resetForm}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={isSubmitting}>
                                {isSubmitting ? "Submitting..." : "Submit"}
                            </Button>
                        </CardFooter>
                    </form>
                </Card>
            )}

        </div>
    );
}
