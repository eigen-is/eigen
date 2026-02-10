"use client"

import {useCallback, useEffect, useRef, useState} from "react"
import {UserPublicItem} from "../user-item"
import type {DriveACL, DrivePath} from "@workspace/lib/types/drive"
import {cn} from "@workspace/ui/lib/utils"
import {usePublicUser} from "@workspace/lib/public"
import {Lock, Plus, Unlock} from "lucide-react"
import {AvatarIcon} from "@workspace/ui/components/avatar"
import {Separator} from "@workspace/ui/components/separator"
import {Button} from "@workspace/ui/components/button"
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@workspace/ui/components/select"
import {ContactAutosuggest} from "../contacts/contact-autosuggest"
import {ContactSuggestion} from "../contacts/types"

export type DriveAccessListEditProps = {
    path: DrivePath
    onSave: (updatedAcl: DriveACL[]) => void
    onCancel?: () => void
    className?: string
}

type UserAccessItem = {
    email: string
    read: boolean
    write: boolean
    public: boolean
    owner: boolean
    isNew?: boolean
    displayName?: string
}

export function DriveAccessListEdit({
                                        path,
                                        onSave,
                                        onCancel,
                                        className,
                                    }: DriveAccessListEditProps) {
    const owner = usePublicUser(path.ownerId)
    const [pendingChanges, setPendingChanges] = useState(false)
    const [newContactInput, setNewContactInput] = useState("")
    const inputRef = useRef<HTMLInputElement>(null)

    // State for access list including original and added users
    const [accessList, setAccessList] = useState<UserAccessItem[]>(() => {
        const initialList: UserAccessItem[] = []

        // First initialize with empty list, we'll populate it when owner data is available
        return initialList
    })

    // State for public access
    const [isPublicEnabled, setIsPublicEnabled] = useState(false)
    const [publicAccessRights, setPublicAccessRights] = useState({
        read: true,
        write: true
    })

    useEffect(() => {
        if (!owner.data) return

        const ownerAccess = {
            email: owner.data.email || '',
            read: true,
            write: true,
            public: false,
            owner: true
        }

        const newAccessList = [ownerAccess]

        if (path.acl && path.acl.length > 0) {
            path.acl.forEach((access) => {
                if (access.public) {
                    setIsPublicEnabled(true)
                    setPublicAccessRights({
                        read: access.read,
                        write: access.write
                    })
                } else if (access.email.toLowerCase() !== owner.data?.email.toLowerCase()) {
                    newAccessList.push({
                        email: access.email.toLowerCase(),
                        read: access.read,
                        write: access.write,
                        public: access.public,
                        owner: false
                    })
                }
            })
        }

        setAccessList(newAccessList)
    }, [path, owner.data])

    // Handle adding a new user
    const handleAddUser = useCallback((suggestion: ContactSuggestion) => {
        if (accessList.some(user => user.email.toLowerCase() === suggestion.email.toLowerCase())) {
            return
        }

        const newUser = {
            email: suggestion.email,
            read: true,
            write: true,
            public: false,
            owner: false
        }

        setAccessList(prevList => [...prevList, newUser])

        setPendingChanges(true)
        setNewContactInput("")
    }, [accessList])

    // Parse contact suggestion from input and add user if valid
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

        if (!email.toLowerCase().endsWith('@eigen.is')) {
            return false;
        }

        if (accessList.some(user => user.email.toLowerCase() === email.toLowerCase())) {
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
    }, [accessList, handleAddUser])

    // This is called when a suggestion is selected from the dropdown
    const handleContactSelected = useCallback((value: string) => {
        // If the value contains angle brackets, it's a selected suggestion
        if (value.includes('<') && value.includes('>')) {
            const added = processContactInput(value)
            if (added) {
                setNewContactInput("")
            } else {
                setNewContactInput(value)
            }
        } else {
            // Just update the input value
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

    // Handle changing user permissions
    const handlePermissionChange = useCallback((email: string, permission: string) => {
        setAccessList(prev => prev.map(user => {
            if (user.email === email) {
                if (permission === "remove") {
                    // Mark for removal - will be filtered out when saving
                    return {...user, read: false, write: false}
                } else if (permission === "editor") {
                    return {...user, read: true, write: true}
                } else if (permission === "viewer") {
                    return {...user, read: true, write: false}
                }
            }
            return user
        }))

        setPendingChanges(true)
    }, [])

    // Handle public access toggle
    const handlePublicAccessToggle = useCallback((enabled: boolean) => {
        setIsPublicEnabled(enabled)
        setPendingChanges(true)
    }, [])

    // Handle public permission change
    const handlePublicPermissionChange = useCallback((permission: string) => {
        if (permission === "editor") {
            setPublicAccessRights({read: true, write: true})
        } else if (permission === "viewer") {
            setPublicAccessRights({read: true, write: false})
        }

        setPendingChanges(true)
    }, [])

    // Generate final ACL for saving
    const handleSave = useCallback(() => {
        const updatedAcl: DriveACL[] = []

        // Add all non-owner users that aren't removed
        accessList.forEach(user => {
            if (!user.owner && (user.read || user.write)) {
                updatedAcl.push({
                    email: user.email,
                    read: user.read,
                    write: user.write,
                    public: false
                })
            }
        })

        // Add public access if enabled
        if (isPublicEnabled) {
            updatedAcl.push({
                email: "",
                read: publicAccessRights.read,
                write: publicAccessRights.write,
                public: true
            })
        }

        onSave(updatedAcl)
    }, [accessList, isPublicEnabled, publicAccessRights, onSave])

    return (
        <div className={cn("space-y-4", className)}>

            {/* Contact autosuggest to add new people */}
            <div>
                <div className="flex mt-2">
                    <div className="flex-1 relative">
                        <ContactAutosuggest
                            id="new-contact"
                            value={newContactInput}
                            onChange={handleContactSelected}
                            onlyEigenIsMails={true}
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

            {/* People with access list */}
            <div className="space-y-2">
                <h4 className="text-base font-medium">People with access</h4>

                {accessList.map((access) => (
                    <div key={access.email} className="flex items-center justify-between">
                        <><UserPublicItem
                            email={access.email}
                        />
                            {!access.owner && (
                                <Select
                                    defaultValue={access.write ? "editor" : "viewer"}
                                    onValueChange={(value) => handlePermissionChange(access.email, value)}
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
                        </>
                    </div>
                ))}
            </div>

            <Separator/>

            {/* General access section */}
            <div>
                <h4 className="text-sm font-medium mb-2">General access</h4>
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center">
                        <AvatarIcon className="w-10 h-10 cursor-pointer"
                                    onClick={() => handlePublicAccessToggle(!isPublicEnabled)}>
                            {isPublicEnabled ? <Unlock/> : <Lock/>}
                        </AvatarIcon>
                        <div className="ml-3">
                            <p className="text-sm font-medium">
                                {isPublicEnabled ? "Unrestricted" : "Restricted"}
                            </p>
                            <p className="text-xs text-gray-500">
                                {isPublicEnabled
                                    ? "Any logged-in eigen user with the link can access"
                                    : "Only people with access can open with the link"}
                            </p>
                        </div>
                    </div>

                    {isPublicEnabled && (
                        <Select
                            defaultValue={publicAccessRights.write ? "editor" : "viewer"}
                            onValueChange={handlePublicPermissionChange}
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

            {/* Action buttons */}
            <div className="flex justify-end space-x-4">
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
    )
}
