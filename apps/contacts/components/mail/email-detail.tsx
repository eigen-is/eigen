import {Archive, ArrowLeft, Clock, Forward, MoreHorizontal, Reply, Star, Tag, Trash} from "lucide-react";

import {Link} from "@tanstack/react-router";
import { Email } from "@workspace/lib/types/mail";
import {cn} from "@workspace/ui/lib/utils";
import {Button} from "@workspace/ui/components/ui/button";

interface EmailDetailProps extends React.HTMLAttributes<HTMLDivElement> {
    email: Email;
}

export function EmailDetail({email, className, ...props}: EmailDetailProps) {
    return (
        <div className={cn("h-full overflow-auto bg-background", className)} {...props}>
            <EmailDetailToolbar/>
            <EmailDetailHeader email={email}/>
            <EmailDetailContent email={email}/>
            <EmailDetailFooter/>
        </div>
    );
}

interface EmailDetailToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
}

export function EmailDetailToolbar({className, ...props}: EmailDetailToolbarProps) {
    return (
        <div className={cn("flex items-center border-b py-2 px-4", className)} {...props}>
            <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                    <Link to="/inbox">
                        <ArrowLeft className="h-4 w-4"/>
                    </Link>
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Archive className="h-4 w-4"/>
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Trash className="h-4 w-4"/>
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Clock className="h-4 w-4"/>
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Tag className="h-4 w-4"/>
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreHorizontal className="h-4 w-4"/>
                </Button>
            </div>
        </div>
    );
}

interface EmailDetailHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
    email: Email;
}

export function EmailDetailHeader({email, className, ...props}: EmailDetailHeaderProps) {
    return (
        <div className={cn("px-4 py-3 border-b", className)} {...props}>
            <h1 className="text-xl font-semibold mb-2">{email.subject}</h1>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <EmailAvatar name={email.from.name}/>
                    <div>
                        <div className="flex items-center gap-1">
                            <span className="font-medium">{email.from.name}</span>
                            <EmailStarButton starred={email.starred}/>
                        </div>
                        <div className="text-xs text-muted-foreground">
                            to me
                        </div>
                    </div>
                </div>
                <div className="text-xs text-muted-foreground">
                    {email.date}, 2025, 10:42 AM
                </div>
            </div>
        </div>
    );
}

interface EmailDetailMetaProps extends React.HTMLAttributes<HTMLDivElement> {
    email: Email;
}

export function EmailDetailMeta({email, className, ...props}: EmailDetailMetaProps) {
    return (
        <div className={cn("", className)} {...props}>

        </div>
    );
}

interface EmailAvatarProps extends React.HTMLAttributes<HTMLDivElement> {
    name: string;
}

export function EmailAvatar({name, className, ...props}: EmailAvatarProps) {
    return (
        <div
            className={cn(
                "w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center text-primary font-medium text-sm",
                className
            )}
            {...props}
        >
            {name.charAt(0)}
        </div>
    );
}

interface EmailStarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    starred: boolean;
}

export function EmailStarButton({starred, className, ...props}: EmailStarButtonProps) {
    return (
        <button
            className={cn("text-muted-foreground hover:text-yellow-400", className)}
            {...props}
        >
            <Star
                size={16}
                fill={starred ? "gold" : "none"}
                color={starred ? "gold" : "currentColor"}
            />
        </button>
    );
}

interface EmailDetailContentProps extends React.HTMLAttributes<HTMLDivElement> {
    email: Email;
}

export function EmailDetailContent({email, className, ...props}: EmailDetailContentProps) {
    return (
        <div className={cn("px-4 py-3 text-foreground", className)} {...props}>
            <p className="mb-2">Hi Team,</p>
            <p className="mb-2">{email.preview}</p>
            <p className="mb-2">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam euismod, nisl eget
                aliquam ultricies, nunc nisl aliquet nunc, quis aliquam nisl nunc quis nisl. Nullam euismod, nisl eget
                aliquam ultricies, nunc nisl aliquet nunc, quis aliquam nisl nunc quis nisl.</p>
            <p className="mb-2">Thank you for your collaboration and prompt attention to this important task!</p>
            <div className="mt-4">
                <p className="mb-0">Ignacio Liaudat • COO & Co-Founder</p>
                <p className="mb-0">{email.from.name} • Operations Manager + Product Owner RM</p>
                <p className="mb-0">monks.com</p>
                <div className="text-2xl font-bold mt-1">.monks</div>
            </div>
        </div>
    );
}

interface EmailDetailFooterProps extends React.HTMLAttributes<HTMLDivElement> {
}

export function EmailDetailFooter({className, ...props}: EmailDetailFooterProps) {
    return (
        <div className={cn("flex items-center gap-2 px-4 py-2 border-t", className)} {...props}>
            <Button size="sm" className="flex items-center gap-1 h-8">
                <Reply className="h-3 w-3"/>
                <span>Reply</span>
            </Button>
            <Button size="sm" variant="outline" className="flex items-center gap-1 h-8">
                <Forward className="h-3 w-3"/>
                <span>Forward</span>
            </Button>
        </div>
    );
}
