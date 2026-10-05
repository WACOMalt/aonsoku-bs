import { MoreHorizontal, UserPlus } from 'lucide-react'
import { FormEvent, ReactNode, useState } from 'react'
import { toast } from 'react-toastify'
import { getSimpleCoverArtUrl } from '@/api/httpClient'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/alert-dialog'
import { Button } from '@/app/components/ui/button'
import { Checkbox } from '@/app/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/app/components/ui/dropdown-menu'
import { Input } from '@/app/components/ui/input'
import { Label } from '@/app/components/ui/label'
import {
  cancelInvite,
  type InviteResult,
  inviteFriend,
  type JoinResult,
  joinFriend,
  removeFriend,
  respondToInvite,
  setFriendSettings,
} from '@/service/friends'
import { useConnectStore } from '@/store/connect.store'
import { type IFriend, useFriendsStore } from '@/store/friends.store'

const INVITE_MESSAGES: Record<InviteResult, string> = {
  sent: 'Invite sent.',
  accepted: 'They had invited you too. You are now friends.',
  not_found:
    'No Aonsoku user with that name yet. They need to open Aonsoku once.',
  self: "That's you.",
  already_friends: "You're already friends.",
  already_invited: 'You already invited them.',
  rate_limited: 'Too many invites. Wait a minute and try again.',
  unavailable: "Couldn't reach the sync server. Try again.",
}

const JOIN_MESSAGES: Partial<Record<JoinResult, string>> = {
  not_allowed: "They don't allow friends to join right now.",
  offline: "They're offline.",
  not_playing: "They aren't playing anything to join.",
  removed: 'The host removed you from their Jam.',
  unavailable: "Couldn't reach the sync server. Try again.",
}

/** The Friends panel, opened from the user menu. */
export function FriendsDialog() {
  const open = useFriendsStore((state) => state.panelOpen)
  const setOpen = useFriendsStore((state) => state.actions.setPanelOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Friends</DialogTitle>
          <DialogDescription>
            Add friends by username, see what they're listening to, and join
            their session.
          </DialogDescription>
        </DialogHeader>
        <FriendsPanel />
      </DialogContent>
    </Dialog>
  )
}

function FriendsPanel() {
  const { loaded, settings, friends, incoming, outgoing } = useFriendsStore()
  const isConnected = useConnectStore((state) => state.isConnected)
  const offline = useConnectStore((state) => state.offline)

  if (offline || !isConnected) {
    return (
      <p className="text-sm text-muted-foreground">
        {offline
          ? 'You are listening offline. Go online to use friends.'
          : 'Friends need the sync server, which is not connected right now.'}
      </p>
    )
  }
  if (!loaded) {
    return (
      <p className="text-sm text-muted-foreground">
        Your sync server doesn't support friends yet. Update the server to use
        them.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <AddFriend />

      {incoming.length > 0 && (
        <Section title={`Invites (${incoming.length})`}>
          {incoming.map((invite) => (
            <Row key={invite.id} name={invite.username}>
              <Button
                size="sm"
                onClick={() => respondToInvite(invite.id, true)}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => respondToInvite(invite.id, false)}
              >
                Decline
              </Button>
            </Row>
          ))}
        </Section>
      )}

      <Section title={`Friends (${friends.length})`}>
        {friends.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No friends yet. Add someone by their username above.
          </p>
        ) : (
          friends.map((friend) => (
            <FriendRow key={friend.username} friend={friend} />
          ))
        )}
      </Section>

      {outgoing.length > 0 && (
        <Section title="Sent invites">
          {outgoing.map((invite) => (
            <Row key={invite.id} name={invite.username} detail="Waiting">
              <Button
                size="sm"
                variant="outline"
                onClick={() => cancelInvite(invite.id)}
              >
                Cancel
              </Button>
            </Row>
          ))}
        </Section>
      )}

      <Section title="Settings">
        <Setting
          id="friends-share-activity"
          label="Share listening activity"
          detail="Your friends see what you're playing."
          checked={settings.shareActivity}
          onChange={(shareActivity) => setFriendSettings({ shareActivity })}
        />
        <Setting
          id="friends-allow-join"
          label="Allow friends to join my session"
          detail="A friend can join you. You stay the Jam's owner."
          checked={settings.allowJoin}
          onChange={(allowJoin) => setFriendSettings({ allowJoin })}
        />
      </Section>
    </div>
  )
}

function AddFriend() {
  const [username, setUsername] = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<{
    text: string
    ok: boolean
  } | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!username.trim() || sending) return
    setSending(true)
    const result = await inviteFriend(username)
    setSending(false)
    const ok = result === 'sent' || result === 'accepted'
    setMessage({ text: INVITE_MESSAGES[result], ok })
    if (ok) setUsername('')
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor="friends-add">Add a friend</Label>
      <div className="flex gap-2">
        <Input
          id="friends-add"
          placeholder="Username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(event) => {
            setUsername(event.target.value)
            setMessage(null)
          }}
        />
        <Button type="submit" disabled={!username.trim() || sending}>
          <UserPlus className="w-4 h-4 mr-2" />
          Send invite
        </Button>
      </div>
      {message && (
        <p
          className={
            message.ok
              ? 'text-sm text-muted-foreground'
              : 'text-sm text-destructive'
          }
        >
          {message.text}
        </p>
      )}
    </form>
  )
}

function FriendRow({ friend }: { friend: IFriend }) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [joining, setJoining] = useState(false)

  const join = async () => {
    setJoining(true)
    const result = await joinFriend(friend.username)
    setJoining(false)
    if (result === 'starting') {
      toast.info(`Joining ${friend.username}...`)
    } else if (result !== 'ready') {
      toast.error(JOIN_MESSAGES[result] ?? "Couldn't join.")
    }
  }

  return (
    <Row
      name={friend.username}
      detail={statusOf(friend)}
      cover={friend.activity?.coverArt}
      online={friend.online}
    >
      {friend.joinable && (
        <Button size="sm" onClick={join} disabled={joining}>
          Join
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={`More for ${friend.username}`}
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => setConfirmRemove(true)}
          >
            Remove friend
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {friend.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              You stop being friends, for both of you. You can invite them again
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => removeFriend(friend.username)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Row>
  )
}

function statusOf(friend: IFriend) {
  if (!friend.online) return 'Offline'
  const { activity } = friend
  if (activity) {
    const what = activity.artist
      ? `${activity.title} by ${activity.artist}`
      : activity.title
    return activity.isPlaying ? `Listening to ${what}` : `Paused: ${what}`
  }
  return friend.inJam ? 'In a Jam' : 'Online'
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function Row({
  name,
  detail,
  cover,
  online,
  children,
}: {
  name: string
  detail?: string
  cover?: string
  online?: boolean
  children?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="relative shrink-0">
        {cover ? (
          <img
            src={getSimpleCoverArtUrl(cover, 'song', '100')}
            alt=""
            className="w-9 h-9 rounded object-cover"
          />
        ) : (
          <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-sm font-medium uppercase">
            {name.charAt(0)}
          </div>
        )}
        {online !== undefined && (
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background ${
              online ? 'bg-green-500' : 'bg-muted-foreground'
            }`}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{name}</p>
        {detail && (
          <p className="text-xs text-muted-foreground truncate">{detail}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">{children}</div>
    </div>
  )
}

function Setting({
  id,
  label,
  detail,
  checked,
  onChange,
}: {
  id: string
  label: string
  detail: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}
