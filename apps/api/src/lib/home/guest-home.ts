import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { getGuestHomePath } from '../config/paths';
import { JsonStore, PATHS } from '../core';
import { Drive } from '../drive';
import { NotificationCenter } from '../notification-center/notification-center';
import type { User } from '../user';
import type { HomeSettings } from './home';
import { Home, homeSize } from './home';

export class GuestHome extends Home {
    public constructor(user: User, onClosed?: () => void) {
        super(user, getGuestHomePath(user.id), onClosed);
        this.settings = new JsonStore<HomeSettings>(this.fs, PATHS.SETTINGS, {});
        this._drive = new Drive(this);
        this._notifications = new NotificationCenter(this);
    }

    public override async size(): Promise<HomeSizeResponse> {
        return homeSize();
    }
}
