import { useQuery } from '@tanstack/react-query'
import { Loader2, RocketIcon } from 'lucide-react'
import { FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import { toast } from 'react-toastify'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/alert-dialog'
import { Badge } from '@/app/components/ui/badge'
import { Button } from '@/app/components/ui/button'
import { useAppUpdate } from '@/store/app.store'
import { useUpdatePrefs } from '@/store/update.store'
import { getAppInfo } from '@/utils/appName'
import { getUpdateSource, UpdateError } from '@/utils/appUpdate'
import { isMacOS } from '@/utils/desktop'
import { logger } from '@/utils/logger'
import { sanitizeLinks } from '@/utils/parseTexts'
import { getNativePlatform } from '@/utils/platform'
import { queryKeys } from '@/utils/queryKeys'

const isAndroid = getNativePlatform() === 'android'

/**
 * Offers a newer version of the app: the desktop app (electron-updater) and
 * the Android app (from the latest GitHub release). See utils/appUpdate.ts.
 */
export function UpdateObserver() {
  const { t } = useTranslation()
  const { openDialog, setOpenDialog, remindOnNextBoot, setRemindOnNextBoot } =
    useAppUpdate()
  const [updateHasStarted, setUpdateHasStarted] = useState(false)
  // Android: the app may not install apps yet; the dialog explains it.
  const [needsPermission, setNeedsPermission] = useState(false)
  const source = getUpdateSource()
  const { autoCheck, skippedVersion, setAutoCheck, setSkippedVersion } =
    useUpdatePrefs()

  const { data: update } = useQuery({
    queryKey: [queryKeys.update.check],
    queryFn: async () => {
      try {
        return (await source?.check()) ?? null
      } catch (error) {
        logger.info('[Update] Could not check for updates', error)
        return null
      }
    },
    // Each start, unless turned off; "Check for updates" (About, Settings)
    // asks at any time.
    enabled: !!source && autoCheck && !remindOnNextBoot,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  // Offered by itself unless it's the version the listener ignored; asking
  // for a check opens the dialog either way (see CheckForUpdates).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new check result
  useEffect(() => {
    if (update && update.version !== skippedVersion) setOpenDialog(true)
  }, [setOpenDialog, update])

  if (!source || !update) return null

  const handleUpdate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (needsPermission && source.grantPermission) {
      // Back from the setting, the next tap installs.
      setNeedsPermission(false)
      await source.grantPermission()
      return
    }

    toast(t('update.toasts.started'), {
      autoClose: false,
      type: 'default',
      isLoading: true,
      toastId: 'update',
      progress: 0,
    })
    setUpdateHasStarted(true)

    try {
      await source.install((fraction) => {
        toast.update('update', { progress: fraction })
      })
      toast.update('update', {
        render: isAndroid
          ? 'Downloaded. Confirm the update, then open Aonsoku again.'
          : t('update.toasts.success'),
        type: 'success',
        autoClose: 5000,
        isLoading: false,
        progress: undefined,
      })
      if (isAndroid) setUpdateHasStarted(false)
    } catch (error) {
      setUpdateHasStarted(false)
      if (error instanceof UpdateError && error.reason === 'needs-permission') {
        toast.dismiss('update')
        setNeedsPermission(true)
        return
      }
      logger.error('[Update] Update failed', error)
      setRemindOnNextBoot(true)
      toast.update('update', {
        render: t('update.toasts.error'),
        type: 'error',
        autoClose: 5000,
        isLoading: false,
        progress: undefined,
      })
    }
  }

  return (
    <AlertDialog open={openDialog}>
      <AlertDialogContent>
        <AlertDialogDescription className="sr-only">
          {t('update.dialog.title')}
        </AlertDialogDescription>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <RocketIcon className="w-6 h-6 text-primary fill-primary/60" />
            <span>{t('update.dialog.title')}</span>
            <Badge>{update.version}</Badge>
          </AlertDialogTitle>
        </AlertDialogHeader>

        <div
          id="update-info-body"
          className="w-full min-h-16 max-h-80 overflow-auto text-muted-foreground bg-background-foreground p-4 border rounded-md"
        >
          <div className="space-y-2 text-sm">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
              {sanitizeLinks(update.notes || update.version)}
            </Markdown>
          </div>
        </div>

        {needsPermission && (
          <p className="text-sm">
            To update, allow Aonsoku to install apps. Tap{' '}
            <strong>Open setting</strong>, turn on{' '}
            <strong>Allow from this source</strong>, come back, then tap{' '}
            <strong>Install update</strong> again.
          </p>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <button
            type="button"
            className="text-muted-foreground underline-offset-4 hover:underline hover:text-foreground disabled:opacity-50"
            disabled={updateHasStarted}
            onClick={() => {
              setSkippedVersion(update.version)
              setOpenDialog(false)
              toast.info(
                `Version ${update.version} won't be offered again. A newer one will.`,
              )
            }}
          >
            Ignore this update
          </button>
          <button
            type="button"
            className="text-muted-foreground underline-offset-4 hover:underline hover:text-foreground disabled:opacity-50"
            disabled={updateHasStarted}
            onClick={() => {
              setAutoCheck(false)
              setOpenDialog(false)
              toast.info(
                'Update checks are off. Turn them back on in Settings → Content → Updates.',
              )
            }}
          >
            Stop checking for updates
          </button>
        </div>

        <AlertDialogFooter>
          <form onSubmit={handleUpdate} className="flex gap-2">
            <Button
              variant="outline"
              disabled={updateHasStarted}
              onClick={() => {
                setOpenDialog(false)
                setRemindOnNextBoot(true)
              }}
              type="button"
            >
              {t('update.dialog.remindLater')}
            </Button>
            {!isMacOS ? (
              <Button
                variant="default"
                disabled={updateHasStarted}
                type="submit"
              >
                {updateHasStarted ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : needsPermission ? (
                  'Open setting'
                ) : isAndroid ? (
                  // Android closes the app to update it; it isn't reopened.
                  'Install update'
                ) : (
                  t('update.dialog.install')
                )}
              </Button>
            ) : (
              <Button variant="default" asChild>
                <a
                  href={getAppInfo().releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('update.dialog.macOS')}
                </a>
              </Button>
            )}
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
