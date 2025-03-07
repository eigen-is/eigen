"use client"

import { ArrowLeft, Star, Reply, Forward, Trash, Archive, Clock, Tag, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Email } from "./email-list";
import { cn } from "@/lib/utils";

interface EmailDetailProps extends React.HTMLAttributes<HTMLDivElement> {
  email: Email;
}

export function EmailDetail({ email, className, ...props }: EmailDetailProps) {
  return (
    <div className={cn("h-full overflow-auto bg-background", className)} {...props}>
      <EmailDetailHeader email={email} />
      <EmailDetailContent email={email} />
      <EmailDetailFooter />
    </div>
  );
}

interface EmailDetailHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  email: Email;
}

export function EmailDetailHeader({ email, className, ...props }: EmailDetailHeaderProps) {
  return (
    <div className={cn("p-4 border-b", className)} {...props}>
      <EmailDetailToolbar />
      <EmailDetailMeta email={email} />
    </div>
  );
}

interface EmailDetailToolbarProps extends React.HTMLAttributes<HTMLDivElement> {}

export function EmailDetailToolbar({ className, ...props }: EmailDetailToolbarProps) {
  return (
    <div className={cn("flex items-center justify-between mb-4", className)} {...props}>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/inbox">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <Button variant="ghost" size="icon">
          <Archive className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon">
          <Trash className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon">
          <Clock className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon">
          <Tag className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

interface EmailDetailMetaProps extends React.HTMLAttributes<HTMLDivElement> {
  email: Email;
}

export function EmailDetailMeta({ email, className, ...props }: EmailDetailMetaProps) {
  return (
    <div className={cn("mb-6", className)} {...props}>
      <h1 className="text-2xl font-bold mb-2">{email.subject}</h1>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <EmailAvatar name={email.from.name} />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{email.from.name}</span>
              <EmailStarButton starred={email.starred} />
            </div>
            <div className="text-sm text-muted-foreground">
              to me
            </div>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {email.date}, 2025, 10:42 AM
        </div>
      </div>
    </div>
  );
}

interface EmailAvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  name: string;
}

export function EmailAvatar({ name, className, ...props }: EmailAvatarProps) {
  return (
    <div 
      className={cn(
        "w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center text-primary font-medium",
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

export function EmailStarButton({ starred, className, ...props }: EmailStarButtonProps) {
  return (
    <button 
      className={cn("text-muted-foreground hover:text-yellow-400", className)} 
      {...props}
    >
      <Star 
        size={18} 
        fill={starred ? "gold" : "none"} 
        color={starred ? "gold" : "currentColor"} 
      />
    </button>
  );
}

interface EmailDetailContentProps extends React.HTMLAttributes<HTMLDivElement> {
  email: Email;
}

export function EmailDetailContent({ email, className, ...props }: EmailDetailContentProps) {
  return (
    <div className={cn("prose max-w-none mb-6 text-foreground", className)} {...props}>
      <p>Hi there,</p>
      <p>{email.preview}</p>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam euismod, nisl eget aliquam ultricies, nunc nisl aliquet nunc, quis aliquam nisl nunc quis nisl. Nullam euismod, nisl eget aliquam ultricies, nunc nisl aliquet nunc, quis aliquam nisl nunc quis nisl.</p>
      <p>Best regards,<br />{email.from.name.split(' ')[0]}</p>
    </div>
  );
}

interface EmailDetailFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

export function EmailDetailFooter({ className, ...props }: EmailDetailFooterProps) {
  return (
    <div className={cn("flex items-center gap-3 pt-4 border-t", className)} {...props}>
      <Button className="flex items-center gap-2">
        <Reply className="h-4 w-4" />
        <span>Reply</span>
      </Button>
      <Button variant="outline" className="flex items-center gap-2">
        <Forward className="h-4 w-4" />
        <span>Forward</span>
      </Button>
    </div>
  );
}
