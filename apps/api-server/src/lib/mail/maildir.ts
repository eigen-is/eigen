// // deze class handelt emails af die in een Maildir achtige mailbox terecht komen
// // 
// import { User } from "@prisma/client";
// import {fsGetDirName} from "../fs";

// export default class Maildir {

//     constructor(user: User) {
//         this.basePath = fsGetDirName(user, 'eigen.mail/Maildir');
//     }

//     async init() {
//         // check if basePath exists
//         const bunfile = Bun.file(this.basePath);
//         if (await bunfile.exists()) {
//             return;
//         } else {
//             await this.createMailboxes();
//         }
//     }

//     async createMailboxes() {
//         // create Maildir
//         await this.createMailBox(this.basePath);
//         // create .Sent, .Trash, .Drafts
//         await this.createMailBox(`${this.basePath}/.Sent`);
//         await this.createMailBox(`${this.basePath}/.Trash`);
//         await this.createMailBox(`${this.basePath}/.Drafts`);
//     }

//     async createMailBox(path: string) {
//         // create directory and new, cur and tmp subdirectories
//         await mkdir(path, {recursive: true});
//         await mkdir(`${path}/new`, {recursive: true});
//         await mkdir(`${path}/cur`, {recursive: true});
//         await mkdir(`${path}/tmp`, {recursive: true});
//     }
    

//     async getMailboxes() {
//         const files = await readdir(this.basePath, { recursive: true });
//         // create json, with names of directories, create hierarchy based on imap path names of dirs
//         const mailboxes = [];
//         for (const file of files) {
//             if (file.startsWith(".")) {
//                 continue;
//             }
//             mailboxes.push({
//                 name: file,
//                 path: `${this.basePath}/${file}`
//             });
//         }
//         return mailboxes;
//     }
// }