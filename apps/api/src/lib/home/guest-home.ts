import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { getGuestHomePath } from '../config/paths';
import { JsonStore, LocalFilesystem } from '../core';
import { Drive } from '../drive';
import { NotificationCenter } from '../notification-center/notification-center';
import type { User } from '../user';
import { Home, type HomeSettings } from './home';

export class GuestHome extends Home {
    constructor(user: User, cleanUp?: () => void) {
        super(user, cleanUp);
        this.homeDir = getGuestHomePath(user.id);
        this.fs = new LocalFilesystem(this.homeDir);
        this.settings = new JsonStore<HomeSettings>(this.fs, 'settings.json', {});
        this._drive = new Drive(this);
        this._notifications = new NotificationCenter(this);
    }

    override async init() {
        await this.settings.load();
        return super.init(false);
    }

    override async size(): Promise<HomeSizeResponse> {
        return {
            mailAndContacts: { used: 0, max: 0 },
            drive: { default: { used: 0, max: 0 } },
            total: { used: 0, max: 0 },
        };
    }
}
