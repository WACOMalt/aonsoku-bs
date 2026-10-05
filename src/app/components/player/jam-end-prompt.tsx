import { useEffect } from 'react'
import { toast } from 'react-toastify'
import { Button } from '@/app/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog'
import { useJamStore } from '@/store/jam.store'
import {
  clearJamSnapshot,
  loadJamSnapshot,
  restoreJamSnapshot,
} from '@/utils/jamSnapshot'

const TITLES = {
  'host-ended': 'The host ended the Jam',
  left: 'You left the Jam',
  ended: 'You ended the Jam',
  expired: 'That Jam has ended',
  removed: 'You were removed from the Jam',
} as const

const NOTICES = {
  'host-ended': 'The host ended the Jam.',
  expired: 'That Jam has ended.',
  removed: 'You were removed from the Jam.',
} as const

/**
 * Shown once when a Jam ends for this listener. Mounted a single time in the
 * layout; the player renders its Jam button twice (mobile and desktop), so a
 * listener there would fire twice.
 */
export function JamEndPrompt() {
  const endPrompt = useJamStore((state) => state.endPrompt)
  const setEndPrompt = useJamStore((state) => state.actions.setEndPrompt)

  // Nothing to restore: just let a guest know why the music moved on.
  useEffect(() => {
    if (!endPrompt || endPrompt.canRestore) return
    if (
      endPrompt.reason === 'host-ended' ||
      endPrompt.reason === 'expired' ||
      endPrompt.reason === 'removed'
    ) {
      toast.info(NOTICES[endPrompt.reason])
    }
    setEndPrompt(null)
  }, [endPrompt, setEndPrompt])

  if (!endPrompt?.canRestore) return null

  const keepJamQueue = () => {
    clearJamSnapshot()
    setEndPrompt(null)
  }

  const restorePreviousQueue = () => {
    const snapshot = loadJamSnapshot()
    if (snapshot) restoreJamSnapshot(snapshot)
    clearJamSnapshot()
    setEndPrompt(null)
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        // Dismissing leaves playback untouched.
        if (!isOpen) keepJamQueue()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TITLES[endPrompt.reason]}</DialogTitle>
          <DialogDescription>
            Go back to what you were listening to before the Jam, or keep the
            Jam's queue and carry on from here.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={keepJamQueue}>
            Continue from the Jam
          </Button>
          <Button onClick={restorePreviousQueue}>Restore my queue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
