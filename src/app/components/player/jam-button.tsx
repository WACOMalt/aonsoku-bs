import { Users } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'react-toastify'
import { Button } from '@/app/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/app/components/ui/dialog'
import { Input } from '@/app/components/ui/input'
import { SimpleTooltip } from '@/app/components/ui/simple-tooltip'
import { Slider } from '@/app/components/ui/slider'
import { Switch } from '@/app/components/ui/switch'
import { connectService } from '@/service/connect'
import { removeFromJam } from '@/service/friends'
import { jamService } from '@/service/jam'
import { useConnectOffline, useConnectState } from '@/store/connect.store'
import {
  IJamParticipant,
  useJamActions,
  useJamState,
  useJamStore,
} from '@/store/jam.store'
import { buildJamInviteLink, parseJamSessionId } from '@/utils/jamLinks'
import { isCapacitor } from '@/utils/platform'
import { shareUrl } from '@/utils/shareLinks'

export function JamButton() {
  const {
    id,
    isConnected,
    participants,
    isLead,
    canGuestsControl,
    isConnecting,
    error,
    syncThreshold,
  } = useJamState()
  const { setSyncThreshold } = useJamActions()
  const [joinId, setJoinId] = useState('')
  const accountJam = useJamStore((state) => state.accountJam)
  const { devices, thisDeviceId } = useConnectState()

  // The Jam belongs to the account and plays on the device that plays
  // audio; on the listener's other devices it is shown from the server.
  const here = isConnected || isConnecting || (!!id && !accountJam)
  const elsewhere = !here && !!accountJam
  const jamId = here ? id : (accountJam?.id ?? null)
  const lead = here ? isLead : !!accountJam?.isLead
  const guestsControl = here ? canGuestsControl : !!accountJam?.canGuestsControl
  const shownParticipants = uniqueByName(
    here ? participants : (accountJam?.participants ?? []),
  )
  const playingOn = devices.find(
    (device) => device.isActivePlayer && device.id !== thisDeviceId,
  )
  const offline = useConnectOffline()

  const handleCreate = () => {
    jamService.createSession()
    toast.success('Jam session created!')
  }

  const handleJoin = () => {
    const sessionId = parseJamSessionId(joinId)
    if (!sessionId) {
      toast.error("That doesn't look like a Jam link or session ID.")
      return
    }
    jamService.switchToSession(sessionId)
    setJoinId('')
  }

  const handleLeave = () => {
    if (elsewhere) {
      connectService.sendJamControl(lead ? 'end' : 'leave')
      toast.info(
        lead
          ? 'Jam session ended for all participants.'
          : 'You have left the Jam session.',
      )
      return
    }
    if (isLead) {
      jamService.endSession()
      toast.info('Jam session ended for all participants.')
    } else {
      jamService.disconnect()
      toast.info('You have left the Jam session.')
    }
  }

  const copyLink = () => {
    // A path link (not #/jam/...) so the Android app can claim it.
    shareUrl({
      url: buildJamInviteLink(jamId!),
      title: 'Join my Jam on Aonsoku',
      copiedMessage: 'Invite link copied!',
    })
  }

  if (offline) {
    return (
      <SimpleTooltip text="You're listening offline. Go online to use Jam.">
        <span>
          <Button
            variant="ghost"
            disabled
            className="rounded-full size-10 p-0 text-secondary-foreground"
          >
            <Users className="size-[18px]" />
          </Button>
        </span>
      </SimpleTooltip>
    )
  }

  return (
    <Dialog>
      <SimpleTooltip text={jamId ? 'Manage Jam' : 'Start Jam'}>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            className={`relative rounded-full size-10 p-0 ${jamId ? 'text-primary' : 'text-secondary-foreground'}`}
          >
            <Users className="size-[18px]" />
            {jamId && (isConnected || elsewhere) && (
              <span className="absolute top-1 right-1 size-2 bg-green-500 rounded-full border-2 border-background" />
            )}
          </Button>
        </DialogTrigger>
      </SimpleTooltip>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Music Jam</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          {!jamId ? (
            <>
              <Button onClick={handleCreate}>Start a new Jam</Button>
              <div className="flex gap-2">
                <Input
                  placeholder="Paste Session ID"
                  value={joinId}
                  onChange={(e) => setJoinId(e.target.value)}
                />
                <Button variant="secondary" onClick={handleJoin}>
                  Join
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <span className="font-bold">Session: {jamId}</span>
                <Button size="sm" variant="outline" onClick={copyLink}>
                  {isCapacitor() ? 'Share Invite Link' : 'Copy Invite Link'}
                </Button>
              </div>

              {elsewhere && (
                <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span>
                    Playing on {playingOn?.name ?? 'another of your devices'}
                  </span>
                  {thisDeviceId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        connectService.transferPlayback(thisDeviceId)
                      }
                    >
                      Play here
                    </Button>
                  )}
                </div>
              )}

              {isConnecting && (
                <p className="text-sm text-muted-foreground">Connecting...</p>
              )}
              {error && (
                <p className="text-sm text-destructive">Error: {error}</p>
              )}

              <div className="bg-secondary/20 p-3 rounded-md">
                <h4 className="text-sm font-semibold mb-2">
                  Participants ({shownParticipants.length})
                </h4>
                <ul className="text-sm space-y-1">
                  {shownParticipants.map((p) => (
                    <li
                      key={p.id}
                      className="flex justify-between items-center gap-2"
                    >
                      <span>
                        {p.name} {p.isLead === true ? '(Host)' : ''}
                      </span>
                      {p.isLead && (
                        <span className="text-[10px] bg-primary/20 px-1 rounded">
                          Lead
                        </span>
                      )}
                      {lead && !p.isLead && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-muted-foreground hover:text-destructive"
                          onClick={() => removeFromJam(p.name)}
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {lead && (
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm">
                    Allow guests to control playback
                  </span>
                  <Switch
                    checked={guestsControl}
                    onCheckedChange={(checked) =>
                      elsewhere
                        ? connectService.sendJamControl('guest_control', {
                            canControl: checked,
                          })
                        : jamService.setGuestControl(checked)
                    }
                  />
                </div>
              )}

              <div className="flex flex-col gap-2 mt-1">
                <div className="flex justify-between items-center">
                  <span className="text-sm">Sync threshold</span>
                  <span className="text-sm font-mono text-muted-foreground">
                    {syncThreshold}s
                  </span>
                </div>
                <Slider
                  min={0.5}
                  max={10}
                  step={0.5}
                  value={[syncThreshold]}
                  onValueChange={([val]) => setSyncThreshold(val)}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Minimum playback drift before snapping to the lead's position.
                </p>
              </div>

              <Button variant="destructive" onClick={handleLeave}>
                {lead ? 'End Jam for all' : 'Leave Jam'}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One entry per person: while a Jam moves between a listener's devices,
 * both can be in it for a moment.
 */
function uniqueByName(participants: IJamParticipant[]) {
  const seen = new Set<string>()
  return participants.filter((participant) => {
    const key = participant.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
