import { Volume2 } from 'lucide-react'
import { Button } from '@/app/components/ui/button'
import { connectService } from '@/service/connect'
import { useConnectState } from '@/store/connect.store'

export function ControllerBanner() {
  const { isActivePlayer, isConnected, devices, thisDeviceId } =
    useConnectState()

  // Only show when connected and NOT the active player
  if (!isConnected || isActivePlayer) return null

  const activeDevice = devices.find((d) => d.isActivePlayer)
  const activeDeviceName = activeDevice?.name || 'another device'

  const handlePlayHere = () => {
    if (thisDeviceId) {
      connectService.transferPlayback(thisDeviceId)
    }
  }

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-primary text-primary-foreground text-sm">
      <div className="flex items-center gap-2">
        <Volume2 className="size-4" />
        <span>
          Listening on <strong>{activeDeviceName}</strong>
        </span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="h-6 text-xs"
        onClick={handlePlayHere}
      >
        Play here instead
      </Button>
    </div>
  )
}
