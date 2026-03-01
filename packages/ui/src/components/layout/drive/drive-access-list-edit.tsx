"use client"

import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {UserPublicItem} from "../user-item"
import type {DriveACL, DrivePath, DriveVisibility} from "@workspace/lib/types/drive"
import {cn} from "@workspace/ui/lib/utils"
import {usePublicUser} from "@workspace/lib/public"
import {useBreadcrumb} from "@workspace/lib/drive"
import {Lock, Plus, Unlock, Users} from "lucide-react"
import {AvatarIcon} from "@workspace/ui/components/avatar"
import {Separator} from "@workspace/ui/components/separator"
import {Button} from "@workspace/ui/components/button"
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@workspace/ui/components/select"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu"
import {ContactAutosuggest} from "../contacts/contact-autosuggest"
import {ContactSuggestion} from "../contacts/types"
import {useOrganization, useTeams} from "@workspace/lib/auth"
import {parseOwnerId, teamOwnerId} from "@workspace/lib/types"

export type DriveAccessListEditProps = {
    path: DrivePath
    onSave: (updatedAcl: DriveACL[], visibility: DriveVisibility) => void
    onCancel?: () => void
    className?: string
}

type DirectAccessItem = {
    id: string
    read: boolean
    write: boolean
    owner: boolean
}

type InheritedAccessItem = {
    id: string
    read: boolean
    write: boolean
    sourceFolderName: string
}

export function DriveAccessListEdit({
                                        path,
                                        onSave,
                                        onCancel,
                                        className,
                                    }: DriveAccessListEditProps) {
    const parsedOwner = useMemo(() => parseOwnerId(path.ownerId), [path.ownerId])
    const isGroupOwned = parsedOwner.type === 'team'
    const owner = usePublicUser(path.ownerId, {enabled: !isGroupOwned})
    const breadcrumb = useBreadcrumb(path.ownerId, path.mountId, path.id)
    const [pendingChanges, setPendingChanges] = useState(false)
    const [newContactInput, setNewContactInput] = useState("")
    const inputRef = useRef<HTMLInputElement>(null)

    const [directList, setDirectList] = useState<DirectAccessItem[]>([])
    const [visibility, setVisibility] = useState<DriveVisibility>(path.visibility ?? 'private')

    // Fetch org and teams for the team sharing picker
    const {data: org} = useOrganization()
    const {data: teams} = useTeams(org?.id)

    // Build a map of teamId -> team name for display
    const teamNameMap = useMemo(() => {
        const map = new Map<string, string>()
        if (teams) {
            for (const team of teams) {
                map.set(team.id, team.name)
            }
        }
        return map
    }, [teams])

    const inheritedList = useMemo<InheritedAccessItem[]>(() => {
        if (!breadcrumb.data || breadcrumb.data.length < 2) return []
        const directIds = new Set(directList.map(u => u.id.toLowerCase()))
        if (owner.data?.email) directIds.add(owner.data.email.toLowerCase())

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
    }, [breadcrumb.data, directList, owner.data])

    useEffect(() => {
        // For group-owned paths (team/org), show the group as owner
        if (isGroupOwned) {
            const ownerAccess: DirectAccessItem = {
                id: path.ownerId,
                read: true,
                write: true,
                owner: true,
            }

            const newDirectList: DirectAccessItem[] = [ownerAccess]

            if (path.acl && path.acl.length > 0) {
                for (const access of path.acl) {
                    newDirectList.push({
                        id: access.id,
                        read: access.read,
                        write: access.write,
                        owner: false,
                    })
                }
            }

            setDirectList(newDirectList)
            setVisibility(path.visibility ?? 'private')
            return
        }

        // For user-owned paths, wait for user data
        if (!owner.data) return

        const ownerAccess: DirectAccessItem = {
            id: owner.data.email || '',
            read: true,
            write: true,
            owner: true
        }

        const newDirectList: DirectAccessItem[] = [ownerAccess]

        if (path.acl && path.acl.length > 0) {
            for (const access of path.acl) {
                if (access.id.toLowerCase() !== owner.data?.email.toLowerCase()) {
                    newDirectList.push({
                        id: access.id,
                        read: access.read,
                        write: access.write,
                        owner: false
                    })
                }
            }
        }

        setDirectList(newDirectList)
        setVisibility(path.visibility ?? 'private')
    }, [path, owner.data, isGroupOwned, parsedOwner, teamNameMap])

    const handleAddUser = useCallback((suggestion: ContactSuggestion) => {
        if (directList.some(item => item.id.toLowerCase() === suggestion.email.toLowerCase())) {
            return
        }

        const newUser: DirectAccessItem = {
            id: suggestion.email.toLowerCase(),
            read: true,
            write: true,
            owner: false
        }

        setDirectList(prevList => [...prevList, newUser])
        setPendingChanges(true)
        setNewContactInput("")
    }, [directList])

    const processContactInput = useCallback((value: string) => {
        const emailMatch = value.match(/<(.+)>/)
        let email: string
        let displayName: string

        if (emailMatch) {
            email = emailMatch[1]
            displayName = value.split('<')[0].trim()
        } else {
            const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
            if (isEmail) {
                email = value.trim().toLowerCase();
                displayName = email.split('@')[0];
            } else {
                return false;
            }
        }

        if (directList.some(item => item.id.toLowerCase() === email.toLowerCase())) {
            return false;
        }

        const suggestion: ContactSuggestion = {
            id: email.toLowerCase(),
            email: email.toLowerCase(),
            displayName: displayName,
            allEmails: [email.toLowerCase()]
        }

        handleAddUser(suggestion)
        return true
    }, [directList, handleAddUser])

    const handleContactSelected = useCallback((value: string) => {
        if (value.includes('<') && value.includes('>')) {
            const added = processContactInput(value)
            if (added) {
                setNewContactInput("")
            } else {
                setNewContactInput(value)
            }
        } else {
            setNewContactInput(value)
        }
    }, [processContactInput])

    const handleAddContactClick = useCallback(() => {
        if (!newContactInput) return
        const added = processContactInput(newContactInput)
        if (added) {
            setNewContactInput("")
        }
    }, [newContactInput, processContactInput])

    const handleAddTeam = useCallback((teamId: string) => {
        const id = teamOwnerId(teamId)
        if (directList.some(item => item.id === id)) return
        setDirectList(prev => [...prev, {
            id,
            read: true,
            write: true,
            owner: false,
        }])
        setPendingChanges(true)
    }, [directList])

    const handlePermissionChange = useCallback((id: string, permission: string) => {
        setDirectList(prev => prev.map(item => {
            if (item.id === id) {
                if (permission === "remove") {
                    return {...item, read: false, write: false}
                } else if (permission === "editor") {
                    return {...item, read: true, write: true}
                } else if (permission === "viewer") {
                    return {...item, read: true, write: false}
                }
            }
            return item
        }))
        setPendingChanges(true)
    }, [])

    const handleVisibilityChange = useCallback((newVisibility: DriveVisibility) => {
        setVisibility(newVisibility)
        setPendingChanges(true)
    }, [])

    const handleSave = useCallback(() => {
        const updatedAcl: DriveACL[] = []

        for (const item of directList) {
            if (!item.owner && (item.read || item.write)) {
                updatedAcl.push({
                    id: item.id,
                    read: item.read,
                    write: item.write,
                })
            }
        }

        onSave(updatedAcl, visibility)
    }, [directList, visibility, onSave])

    return (
        <div className={cn("space-y-4", className)}>

            <div>
                <div className="flex mt-2">
                    <div className="flex-1 relative">
                        <ContactAutosuggest
                            id="new-contact"
                            value={newContactInput}
                            onChange={handleContactSelected}
                            onlyEigenIsMails={false}
                            placeholder="Enter email addresses"
                            inputRef={inputRef}
                            onSubmit={handleAddContactClick}
                        />
                    </div>
                    <Button
                        size="icon"
                        variant="outline"
                        className="ml-2"
                        onClick={handleAddContactClick}
                        disabled={!newContactInput}
                    >
                        <Plus className="h-4 w-4"/>
                    </Button>
                </div>
            </div>

            <Separator/>

            <div className="space-y-2">
                <h4 className="text-base font-medium">People with access</h4>

                {directList.map((access) => {
                    const parsed = parseOwnerId(access.id)
                    const isTeam = parsed.type === 'team'
                    const displayName = isTeam
                        ? (teamNameMap.get(parsed.id) || 'Team') : null
                    return (
                        <div key={access.id} className="flex items-center justify-between">
                            {isTeam ? (
                                <div className="flex items-center gap-3 py-1">
                                    <AvatarIcon className="w-8 h-8">
                                        <Users className="h-4 w-4"/>
                                    </AvatarIcon>
                                    <div>
                                        <p className="text-sm font-medium">{displayName}</p>
                                        <p className="text-xs text-muted-foreground">Team</p>
                                    </div>
                                </div>
                            ) : (
                                <UserPublicItem
                                    email={access.id}
                                />
                            )}
                            {access.owner ? (
                                <span className="text-xs text-muted-foreground w-28 text-right">
                                Owner
                            </span>
                            ) : (
                                <Select
                                    defaultValue={access.write ? "editor" : "viewer"}
                                    onValueChange={(value) => handlePermissionChange(access.id, value)}
                                >
                                    <SelectTrigger className="h-7 w-28">
                                        <SelectValue/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="editor">Editor</SelectItem>
                                        <SelectItem value="viewer">Viewer</SelectItem>
                                        <SelectItem value="remove">Remove</SelectItem>
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                    )
                })}

                {inheritedList.map((access) => {
                    const parsed = parseOwnerId(access.id)
                    const isTeam = parsed.type === 'team'
                    const inheritedName = isTeam ? (teamNameMap.get(parsed.id) || 'Team') : null
                    return (
                        <div key={access.id} className="flex items-center justify-between">
                            {isTeam ? (
                                <div className="flex items-center gap-3 py-1">
                                    <AvatarIcon className="w-8 h-8">
                                        <Users className="h-4 w-4"/>
                                    </AvatarIcon>
                                    <div>
                                        <p className="text-sm font-medium">{inheritedName}</p>
                                        <p className="text-xs text-muted-foreground">
                                            Team · Inherited from
                                            "{access.sourceFolderName}"
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <UserPublicItem
                                    email={access.id}
                                    label={<span
                                        className="text-muted-foreground text-xs">Inherited from "{access.sourceFolderName}"</span>}
                                />
                            )}
                            <span className="text-xs text-muted-foreground w-28 text-right">
                            {access.write ? "Editor" : "Viewer"}
                        </span>
                        </div>
                    )
                })}
            </div>

            <Separator/>

            <div>
                <h4 className="text-sm font-medium mb-2">General access</h4>
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center">
                        <AvatarIcon className="w-10 h-10 cursor-pointer"
                                    onClick={() => handleVisibilityChange(visibility === 'private' ? 'public-read' : 'private')}>
                            {visibility !== 'private' ? <Unlock/> : <Lock/>}
                        </AvatarIcon>
                        <div className="ml-3">
                            <p className="text-sm font-medium">
                                {visibility !== 'private' ? "Unrestricted" : "Restricted"}
                            </p>
                            <p className="text-xs text-gray-500">
                                {visibility !== 'private'
                                    ? "Anyone with the link can access"
                                    : "Only people with access can open with the link"}
                            </p>
                        </div>
                    </div>

                    {visibility !== 'private' && (
                        <Select
                            value={visibility === 'public-write' ? "editor" : "viewer"}
                            onValueChange={(v) => handleVisibilityChange(v === 'editor' ? 'public-write' : 'public-read')}
                        >
                            <SelectTrigger className="h-8 w-28">
                                <SelectValue/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="editor">Can edit</SelectItem>
                                <SelectItem value="viewer">Can view</SelectItem>
                            </SelectContent>
                        </Select>
                    )}
                </div>
            </div>

            <Separator/>

            <div className="flex justify-between">
                <div>
                    {teams && teams.length > 0 && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" className="gap-2">
                                    <Users className="h-4 w-4"/>
                                    Share with team
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                {teams.map((team) => (
                                    <DropdownMenuItem
                                        key={team.id}
                                        onClick={() => handleAddTeam(team.id)}
                                        disabled={directList.some(i => i.id === teamOwnerId(team.id))}
                                    >
                                        <Users className="h-4 w-4 mr-2"/>
                                        {team.name}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
                <div className="flex space-x-4">
                    {onCancel && (
                        <Button variant="outline" onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                    <Button
                        onClick={handleSave}
                        disabled={!pendingChanges}
                    >
                        {pendingChanges ? "Save" : "Done"}
                    </Button>
                </div>
            </div>
        </div>
    )
}
