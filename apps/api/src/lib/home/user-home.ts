import type { UserSettings } from '@workspace/lib/types/settings';
import type { User } from 'better-auth/types';
import { Calendar } from '../calendar/calendar';
import { getUserHomePath } from '../config/paths.ts';
import { getServerSettings, mapStorageType } from '../config/server-settings';
import { Contacts } from '../contacts/contacts.ts';
import { JsonStore, LocalFilesystem } from '../core';
import { Drive } from '../drive';
import Maildir from '../mail/maildir.ts';
import { NotificationCenter } from '../notification-center/notification-center';
import { Home } from './home.ts';

export class UserHome extends Home {
    public declare settings: JsonStore<UserSettings>;

    constructor(user: User, cleanUp?: () => void) {
        super(user, cleanUp);
        this.user = user;
        this.homeDir = getUserHomePath(user.id);
        this.fs = new LocalFilesystem(this.homeDir);

        this.settings = new JsonStore<UserSettings>(this.fs, 'settings.json', {});
        this._contacts = new Contacts(this);
        this._mail = new Maildir(this);
        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
        this._notifications = new NotificationCenter(this);
    }

    override async init() {
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
