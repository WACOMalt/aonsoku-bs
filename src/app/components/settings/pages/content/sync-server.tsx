import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Content,
  ContentItem,
  ContentItemTitle,
  Header,
  HeaderDescription,
  HeaderTitle,
  Root,
} from '@/app/components/settings/section'
import { Button } from '@/app/components/ui/button'
import { Input } from '@/app/components/ui/input'
import { connectService } from '@/service/connect'
import { useJamStore } from '@/store/jam.store'

export function SyncServerContent() {
  const { t } = useTranslation()
  const syncServerUrl = useJamStore((s) => s.syncServerUrl)
  const setSyncServerUrl = useJamStore((s) => s.actions.setSyncServerUrl)

  const [localUrl, setLocalUrl] = useState(syncServerUrl)
  const [saved, setSaved] = useState(false)

  const isWebOriginUsable = (() => {
    const origin = window.location.origin
    return origin.startsWith('http://') || origin.startsWith('https://')
  })()

  const handleSave = () => {
    // Strip trailing slash
    const cleaned = localUrl.replace(/\/+$/, '')
    setSyncServerUrl(cleaned)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)

    // Reconnect the connect service with the new URL
    connectService.disconnect()
    connectService.connect()
  }

  return (
    <Root>
      <Header>
        <HeaderTitle>
          {t('settings.content.syncServer.group', 'Jam / Connect Server')}
        </HeaderTitle>
        <HeaderDescription>
          {isWebOriginUsable
            ? t(
                'settings.content.syncServer.descriptionWeb',
                'The sync server is automatically detected from the current page URL. Override it below if needed.',
              )
            : t(
                'settings.content.syncServer.descriptionElectron',
                'In the desktop app, you must set the URL of your Aonsoku-BS web deployment so Jam and Connect features can reach the sync server.',
              )}
        </HeaderDescription>
      </Header>
      <Content>
        <ContentItem>
          <ContentItemTitle
            info={t(
              'settings.content.syncServer.url.info',
              'The base URL of your Aonsoku-BS web app (e.g. https://mus.example.com). The jam-sync server must be running behind this URL.',
            )}
          >
            {t('settings.content.syncServer.url.label', 'Sync Server URL')}
          </ContentItemTitle>
        </ContentItem>
        <div className="flex gap-2">
          <Input
            placeholder="https://mus.example.com"
            value={localUrl}
            onChange={(e) => {
              setLocalUrl(e.target.value)
              setSaved(false)
            }}
            className="flex-1"
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={localUrl === syncServerUrl}
          >
            {saved
              ? t('settings.content.syncServer.saved', 'Saved!')
              : t('settings.content.syncServer.save', 'Save')}
          </Button>
        </div>
        {isWebOriginUsable && (
          <p className="text-xs text-muted-foreground">
            {t(
              'settings.content.syncServer.autoDetected',
              'Auto-detected: {{origin}}. Leave blank to use auto-detection.',
            ).replace('{{origin}}', window.location.origin)}
          </p>
        )}
        {!isWebOriginUsable && !syncServerUrl && (
          <p className="text-xs text-destructive">
            {t(
              'settings.content.syncServer.required',
              'A sync server URL is required for Jam and Connect features to work in the desktop app.',
            )}
          </p>
        )}
      </Content>
    </Root>
  )
}
