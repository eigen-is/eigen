import type { UserSettings } from '@workspace/lib/types/settings';
import { Calendar } from '../calendar/calendar';
import { getUserHomePath } from '../config/paths';
import { getServerSettings, mapStorageType } from '../config/server-settings';
import { Contacts } from '../contacts/contacts';
import { JsonStore, LocalFilesystem } from '../core';
import { Drive } from '../drive';
import { Mail } from '../mail/mail-domain';
import { MaildirStore } from '../mail/maildir-store';
import { NotificationCenter } from '../notification-center/notification-center';
import type { User } from '../user';
import { Home } from './home';

export class UserHome extends Home {
    public declare settings: JsonStore<UserSettings>;

    constructor(user: User, cleanUp?: () => void) {
        super(user, cleanUp);
        this.user = user;
        this.homeDir = getUserHomePath(user.id);
        this.fs = new LocalFilesystem(this.homeDir);

        this.settings = new JsonStore<UserSettings>(this.fs, 'settings.json', {});
        this._contacts = new Contacts(this);
        this._mail = new Mail(this, new MaildirStore(this));
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
