import {User} from "better-auth/types";
import {imap_mailboxes_list} from "./imap";

export async function getMailboxes(user: User) {
    const {mailboxes} = await imap_mailboxes_list(user);
    return mailboxes;
    // create hierarchy based on folder names
    // const hierarchy : {};
    // for (const box of mailboxes) {
    //     const parts = box.name.split("/");
    //     let current = hierarchy;
    //     for (const part of parts) {
    //         if (!current[part]) {
    //             current[part] = {};
    //         }
    //         current = current[part];
    //     }
    // }
}

