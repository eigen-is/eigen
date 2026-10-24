// A user home holds everything one person keeps on this server, such as their files, mail, calendar
// and notifications. Before its parts open, it makes sure the user has a default drive, sized by the
// server settings, so a new user can upload files right away.

import type { UserSettings } from '@workspace/lib/types/settings';
import { Calendar } from '../calendar/calendar';
import { getUserHomePath } from '../config/paths';
import { getServerSettings, mapStorageType } from '../config/server-settings';
import { Contacts } from '../contacts/contacts';
import { JsonStore, PATHS } from '../core';
import { Drive } from '../drive';
import { Mail } from '../mail/mail-domain';
import { MaildirStore } from '../mail/maildir-store';
import { NotificationCenter } from '../notification-center/notification-center';
import type { User } from '../user';
import { Home } from './home';

export class UserHome extends Home {
    public declare settings: JsonStore<UserSettings>;

    public constructor(user: User, onClosed?: () => void) {
        super(user, getUserHomePath(user.id), onClosed);
        this.settings = new JsonStore<UserSettings>(this.fs, PATHS.SETTINGS, {});
        this._contacts = new Contacts(this);
        this._mail = new Mail(this, new MaildirStore(this));
        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
        this._notifications = new NotificationCenter(this);
    }

    public override async init(): Promise<this> {
        await this.settings.load();
        if (!this.settings.get().mounts?.['default']) {
            const serverSettings = getServerSettings();
            await this.settings.set({
                mounts: {
                    default: {
                        storageType: mapStorageType(serverSettings.defaults.mount.storageType),
                        maxSizeMB: serverSettings.quotas.defaultMountMaxSizeMB,
                        enabled: true,
                    },
                },
            });
        }
        return super.init(true);
    }
}
