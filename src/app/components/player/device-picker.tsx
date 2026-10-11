import { CloudOff, Monitor, Smartphone, Tablet, Volume2 } from 'lucide-react'
import { useState } from 'react'
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/app/components/ui/popover'
import { SimpleTooltip } from '@/app/components/ui/simple-tooltip'
import { connectService } from '@/service/connect'
import { goOffline, goOnline, offlineEndsHostedJam } from '@/service/offline'
import { useConnectOffline, useConnectState } from '@/store/connect.store'

export function DevicePicker() {
  const { devices, thisDeviceId, isConnected } = useConnectState()
  const offline = useConnectOffline()
  const [open, setOpen] = useState(false)
  const [confirmEndJam, setConfirmEndJam] = useState(false)

  if (!isConnected && !offline) return null

  const handleTransfer = (deviceId: string) => {
    connectService.transferPlayback(deviceId)
  }

  const handleGoOffline = () => {
    setOpen(false)
    if (offlineEndsHostedJam()) setConfirmEndJam(true)
    else goOffline()
  }

  const handleGoOnline = () => {
    setOpen(false)
    goOnline()
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <SimpleTooltip
          text={offline ? 'Listening offline' : 'Connect to a device'}
        >
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className={`relative rounded-full size-10 p-0 ${
                devices.length > 1 && !offline
                  ? 'text-primary'
                  : 'text-secondary-foreground'
              }`}
            >
              {offline ? (
                <CloudOff className="size-[18px]" />
              ) : (
                <Monitor className="size-[18px]" />
              )}
              {!offline && devices.length > 1 && (
                <span className="absolute -top-0.5 -right-0.5 text-[10px] bg-primary text-primary-foreground rounded-full size-4 flex items-center justify-center">
                  {devices.length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </SimpleTooltip>

        <PopoverContent className="w-72" align="end">
          {offline ? (
            <div className="flex flex-col gap-3">
              <h4 className="font-semibold text-sm">Listening offline</h4>
              <p className="text-sm text-muted-foreground">
                What you play here stays on this device. Your other devices and
                Jams carry on without it, and cannot control it.
              </p>
              <Button size="sm" onClick={handleGoOnline}>
                Go online
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <h4 className="font-semibold text-sm">Devices</h4>

              {devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No devices connected
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {devices.map((device) => {
                    const isThis = device.id === thisDeviceId
                    const isActive = device.isActivePlayer

                    return (
                      <li
                        key={device.id}
                        className={`flex items-center justify-between p-2 rounded-md ${
                          isActive
                            ? 'bg-primary/10 border border-primary/20'
                            : 'bg-secondary/20'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {isActive ? (
                            <Volume2 className="size-4 text-primary shrink-0" />
                          ) : device.name.includes('iPad') ? (
                            <Tablet className="size-4 text-muted-foreground shrink-0" />
                          ) : /Android|iOS|iPhone|Mobile/.test(device.name) ? (
                            <Smartphone className="size-4 text-muted-foreground shrink-0" />
                          ) : (
                            <Monitor className="size-4 text-muted-foreground shrink-0" />
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {device.name}
                              {isThis && (
                                <span className="text-muted-foreground">
                                  {' '}
                                  (this device)
                                </span>
                              )}
                            </p>
                            {isActive && (
                              <p className="text-xs text-primary">
                                Listening on this device
                              </p>
                            )}
                          </div>
                        </div>

                        {!isActive && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 ml-2"
                            onClick={() => handleTransfer(device.id)}
                          >
                            Transfer
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {devices.length <= 1 && (
                <p className="text-xs text-muted-foreground">
                  Open this app on another device to see it here.
                </p>
              )}

              <div className="flex flex-col gap-1 border-t pt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  className="justify-start gap-2 px-2"
                  onClick={handleGoOffline}
                >
                  <CloudOff className="size-4" />
                  Listen offline on this device
                </Button>
                <p className="text-xs text-muted-foreground px-2">
                  Keeps what you play here out of your online session until you
                  go online again.
                </p>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <AlertDialog open={confirmEndJam} onOpenChange={setConfirmEndJam}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End your Jam?</AlertDialogTitle>
            <AlertDialogDescription>
              You're hosting this Jam. Going offline ends it for everyone in it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={goOffline}>
              End Jam and go offline
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
