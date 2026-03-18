import {Home} from "./home.ts";
import type {User} from "better-auth/types";
import {getUserHomePath} from "../config/paths.ts";
import {Contacts} from "../contacts/contacts.ts";
import Maildir from "../mail/maildir.ts";
import {Drive} from "../drive";
import {JsonStore, LocalFilesystem} from "../core";
import {Calendar} from "../calendar/calendar";
import type {UserSettings} from "@workspace/lib/types/settings";
import {getServerSettings, mapStorageType} from "../config/server-settings";

export class UserHome extends Home {
    declare public settings: JsonStore<UserSettings>;

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
                    }
                }
            });
        }
        return super.init(true);
    }
}
