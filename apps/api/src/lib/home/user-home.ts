// A user home holds everything one person keeps on this server, such as their files, mail, calendar
// and notifications. When the user's settings name no default drive yet, it saves one there before
// the parts open, sized by the server settings, so a new user can upload files right away.

import type { UserSettings } from '@workspace/lib/types/settings';
import { Calendar } from '../calendar/calendar';
import { getUserHomePath, PATHS } from '../config/paths';
import { Contacts } from '../contacts/contacts';
import { JsonStore } from '../core';
import { Drive } from '../drive';
import { Mail } from '../mail/mail-domain';
import { MaildirStore } from '../mail/maildir-store';
import { DEFAULT_MOUNT_ID, newMountSettings } from '../mount';
import { NotificationCenter } from '../notification-center/notification-center';
import type { User } from '../user';
import { Home } from './home';

export class UserHome extends Home {
    public override readonly settings = new JsonStore<UserSettings>(this.fs, PATHS.SETTINGS, {});

    public constructor(user: User, onClosed?: () => void) {
        super(user, getUserHomePath(user.id), onClosed);
        this._contacts = new Contacts(this);
        this._mail = new Mail(this, new MaildirStore(this));
        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
        this._notifications = new NotificationCenter(this);
    }

    protected override async loadSettings(): Promise<void> {
        await super.loadSettings();
        if (!this.settings.get().mounts?.[DEFAULT_MOUNT_ID]) {
            await this.settings.set({ mounts: { [DEFAULT_MOUNT_ID]: newMountSettings() } });
        }
    }
}
