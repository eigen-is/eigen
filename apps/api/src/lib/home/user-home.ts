import {Home} from "./home.ts";
import type {User} from "better-auth/types";
import {getUserHomePath} from "../config/paths.ts";
import {Contacts} from "../contacts/contacts.ts";
import Maildir from "../mail/maildir.ts";
import {Drive} from "../drive";
import {LocalFilesystem} from "../core";
import {Calendar} from "../calendar/calendar";

export class UserHome extends Home {
    constructor(user: User, cleanUp?: () => void) {
        super(user, cleanUp);
        this.user = user;
        this.homeDir = getUserHomePath(user.id);
        this.fs = new LocalFilesystem(this.homeDir);

        this._contacts = new Contacts(this);
        this._mail = new Maildir(this);
        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
    }
}
