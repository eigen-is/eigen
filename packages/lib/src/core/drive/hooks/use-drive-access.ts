import {useMemo} from "react"
import {usePublicConfig, usePublicUser} from "../../public"
import {usePeopleTeams} from "../../people"
import {useAuth} from "../../auth"
import {useBreadcrumb} from "../index"
import {parseOwnerId} from "../../../types"
import type {DrivePath} from "../../../types/drive"

export type DirectAccessItem = {
    id: string
    read: boolean
    write: boolean
    owner: boolean
}

export type InheritedAccessItem = {
    id: string
    read: boolean
    write: boolean
    sourceFolderName: string
}

export type DriveAccessItem =
    | (DirectAccessItem & { inherited?: never, sourceFolderName?: never })
    | (InheritedAccessItem & { owner?: never, inherited: true })

export function useDriveAccess(path: DrivePath, overrideDirectList?: DirectAccessItem[]) {
    const parsedOwner = useMemo(() => parseOwnerId(path.ownerId), [path.ownerId])
    const isGroupOwned = parsedOwner.type === 'team'
    const owner = usePublicUser(path.ownerId)
    const breadcrumb = useBreadcrumb(path.ownerId, path.mountId, path.id)

    const baseDirectList = useMemo<DirectAccessItem[]>(() => {
        const list: DirectAccessItem[] = []

        if (isGroupOwned) {
            list.push({
                id: path.ownerId,
                read: true,
                write: true,
                owner: true,
            })
        } else if (owner.data?.email) {
            list.push({
                id: owner.data.email,
                read: true,
                write: true,
                owner: true
            })
        } else {
            return []
        }

        if (path.acl && path.acl.length > 0) {
            for (const access of path.acl) {
                if (!isGroupOwned && owner.data?.email && access.id.toLowerCase() === owner.data.email.toLowerCase()) {
                    continue
                }
                if (isGroupOwned && access.id.toLowerCase() === path.ownerId.toLowerCase()) {
                    continue
                }
                list.push({
                    id: access.id,
                    read: access.read,
                    write: access.write,
                    owner: false
                })
            }
        }

        return list
    }, [path.acl, path.ownerId, isGroupOwned, owner.data?.email])

    const directList = overrideDirectList ?? baseDirectList

    const inheritedList = useMemo<InheritedAccessItem[]>(() => {
        if (!breadcrumb.data || breadcrumb.data.length < 2) return []
        const directIds = new Set(directList.map(u => u.id.toLowerCase()))
        if (owner.data?.email) directIds.add(owner.data.email.toLowerCase())
        if (isGroupOwned) directIds.add(path.ownerId.toLowerCase())

        const inherited: InheritedAccessItem[] = []
        const seenKeys = new Set<string>()

        const ancestors = breadcrumb.data.slice(0, -1)
        for (const ancestor of [...ancestors].reverse()) {
            if (!ancestor.acl) continue
            for (const acl of ancestor.acl) {
                const key = acl.id.toLowerCase()
                if (directIds.has(key) || seenKeys.has(key)) continue
                seenKeys.add(key)
                inherited.push({
                    id: acl.id,
                    read: acl.read,
                    write: acl.write,
                    sourceFolderName: ancestor.name,
                })
            }
        }
        return inherited
    }, [breadcrumb.data, directList, owner.data?.email, isGroupOwned, path.ownerId])

    const allEntries = useMemo<DriveAccessItem[]>(() => {
        const seen = new Set<string>()
        const result: DriveAccessItem[] = []

        for (const item of directList) {
            const key = item.id.toLowerCase()
            if (!seen.has(key)) {
                seen.add(key)
                result.push(item)
            }
        }

        for (const item of inheritedList) {
            const key = item.id.toLowerCase()
            if (!seen.has(key)) {
                seen.add(key)
                result.push({...item, inherited: true})
            }
        }

        return result
    }, [directList, inheritedList])

    return {
        parsedOwner,
        isGroupOwned,
        owner,
        breadcrumb,
        baseDirectList,
        directList,
        inheritedList,
        allEntries
    }
}

export function useIsEffectiveOwner(ownerId: string): boolean {
    const {user} = useAuth()
    const {data: config} = usePublicConfig()
    const {data: teams} = usePeopleTeams(config?.orgId)

    return useMemo(() => {
        if (!user) return false
        if (ownerId === user.id) return true
        const parsed = parseOwnerId(ownerId)
        if (parsed.type === 'team' && teams) {
            return teams.some(t => t.id === parsed.id)
        }
        return false
    }, [user, ownerId, teams])
}
