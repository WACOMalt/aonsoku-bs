import { useCallback, useEffect, useState } from 'react'
import {
  Content,
  ContentItem,
  ContentItemForm,
  ContentItemTitle,
  ContentSeparator,
  Header,
  HeaderDescription,
  HeaderTitle,
  Root,
} from '@/app/components/settings/section'
import { Button } from '@/app/components/ui/button'
import { Input } from '@/app/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select'
import { Switch } from '@/app/components/ui/switch'
import {
  getSongCacheBackend,
  SongCacheUsage,
} from '@/service/song-cache/backend'
import { keptSongs, release, releaseAll } from '@/service/song-cache/kept'
import {
  KeptItem,
  keptId,
  SongCacheState,
  useSongCache,
} from '@/store/song-cache.store'
import { ISong } from '@/types/responses/song'
import { getNativePlatform } from '@/utils/platform'

const GB = 1024 ** 3
const PRESETS = [1, 2, 5, 10, 20]
// While this section is open, progress is read this often.
const REFRESH_MS = 3000

export function formatBytes(bytes: number) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

const KIND_LABEL: Record<KeptItem['kind'], string> = {
  song: 'Song',
  album: 'Album',
  artist: 'Artist',
  playlist: 'Playlist',
}

/** Settings → Content: the songs cached and kept on this device. */
export function SongsCacheContent() {
  const backend = getSongCacheBackend()
  const { cachePlayed, setCachePlayed, wifiOnly, setWifiOnly, kept } =
    useSongCache()
  const [usage, setUsage] = useState<SongCacheUsage | null>(null)
  const [progress, setProgress] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    if (!backend) return
    setUsage(await backend.usage().catch(() => null))
    const items = Object.values(useSongCache.getState().kept)
    const lists = await Promise.all(
      items.map((item) => keptSongs(keptId(item.kind, item.id))),
    )
    const all = new Map<string, ISong>()
    for (const list of lists) for (const song of list) all.set(song.id, song)
    const states = await backend.status([...all.values()]).catch(() => ({}))
    const next: Record<string, string> = {}
    items.forEach((item, index) => {
      next[keptId(item.kind, item.id)] = describe(lists[index], states)
    })
    setProgress(next)
  }, [backend])

  useEffect(() => {
    if (!backend) return
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    const stop = backend.onChange(refresh)
    return () => {
      clearInterval(timer)
      stop()
    }
  }, [backend, refresh])

  const keptItems = Object.values(kept).sort((a, b) => b.addedAt - a.addedAt)

  return (
    <Root>
      <Header>
        <HeaderTitle>Songs on this device</HeaderTitle>
        <HeaderDescription>
          Songs play from this device when they're here, instead of from the
          server. Use Keep cached on a song, album, artist or playlist to
          download it ahead and keep it.
        </HeaderDescription>
      </Header>
      <Content>
        <ContentItem>
          <ContentItemTitle info="Each song you play is kept, so the next time it plays from this device. When the cache is full, the songs played longest ago are removed.">
            Cache songs I play
          </ContentItemTitle>
          <ContentItemForm>
            <Switch checked={cachePlayed} onCheckedChange={setCachePlayed} />
          </ContentItemForm>
        </ContentItem>
        {backend && (
          <>
            <CacheSizeItem />
            {getNativePlatform() === 'android' && (
              <ContentItem>
                <ContentItemTitle info="Kept songs wait for Wi-Fi before they download. Songs you play still stream and cache on any network.">
                  Download kept songs on Wi-Fi only
                </ContentItemTitle>
                <ContentItemForm>
                  <Switch checked={wifiOnly} onCheckedChange={setWifiOnly} />
                </ContentItemForm>
              </ContentItem>
            )}
            {usage && (
              <ContentItem>
                <ContentItemTitle>Space used</ContentItemTitle>
                <ContentItemForm className="text-sm text-muted-foreground text-right">
                  <UsageText usage={usage} />
                </ContentItemForm>
              </ContentItem>
            )}
            <ContentItem>
              <ContentItemTitle info="Removes the songs cached as they played. Kept songs stay.">
                Clear played songs
              </ContentItemTitle>
              <ContentItemForm>
                <ConfirmButton
                  label="Clear"
                  onConfirm={async () => {
                    await backend.clearPlayed()
                    refresh()
                  }}
                />
              </ContentItemForm>
            </ContentItem>
          </>
        )}
      </Content>
      {backend && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              Kept on this device ({keptItems.length})
            </span>
            {keptItems.length > 0 && (
              <ConfirmButton
                label="Remove all"
                onConfirm={async () => {
                  await releaseAll()
                  refresh()
                }}
              />
            )}
          </div>
          {keptItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Choose Keep cached in the menu of a song, album,
              artist or playlist.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {keptItems.map((item) => {
                const id = keptId(item.kind, item.id)
                return (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {KIND_LABEL[item.kind]} · {progress[id] ?? '…'}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => release(item.kind, item.id)}
                    >
                      Remove
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      <ContentSeparator />
    </Root>
  )
}

/** "38 of 40 songs", "Waiting for Wi-Fi", "All 40 songs" and so on. */
function describe(songs: ISong[], states: Record<string, SongCacheState>) {
  const total = songs.length
  let done = 0
  let waiting = 0
  let failed = 0
  for (const song of songs) {
    const state = states[song.id]
    if (state === 'kept') done++
    else if (state === 'waiting') waiting++
    else if (state === 'failed') failed++
  }
  const noun = total === 1 ? 'song' : 'songs'
  if (done === total)
    return total === 1 ? 'On this device' : `All ${total} ${noun}`
  if (waiting > 0 && done + waiting + failed === total) {
    return `${done} of ${total} ${noun} · Waiting for Wi-Fi`
  }
  if (failed > 0)
    return `${done} of ${total} ${noun} · ${failed} failed, retrying later`
  return `${done} of ${total} ${noun} downloaded`
}

function UsageText({ usage }: { usage: SongCacheUsage }) {
  const limit = useSongCache((state) => state.limit)
  const pending =
    usage.keptPending > 0 ? `, ${usage.keptPending} to download` : ''
  return (
    <span>
      Played: {formatBytes(usage.played)}
      {limit > 0 ? ` of ${formatBytes(limit)}` : ''}
      <br />
      Kept: {formatBytes(usage.kept)} ({usage.keptSongs} songs{pending})
      {usage.free !== undefined && (
        <>
          <br />
          Free on this device: {formatBytes(usage.free)}
        </>
      )}
    </span>
  )
}

/** Cache size: a preset, No limit, or any size typed in GB. */
function CacheSizeItem() {
  const { limit, setLimit } = useSongCache()
  const preset =
    limit === 0
      ? 'none'
      : PRESETS.includes(limit / GB)
        ? String(limit / GB)
        : 'custom'
  const [custom, setCustom] = useState(preset === 'custom')
  const [typed, setTyped] = useState(String(+(limit / GB).toFixed(2)))
  const shown = custom ? 'custom' : preset

  function applyTyped() {
    const gb = Number.parseFloat(typed.replace(',', '.'))
    if (Number.isFinite(gb) && gb >= 0.1) setLimit(gb * GB)
    else setTyped(String(+(limit / GB).toFixed(2)))
  }

  return (
    <ContentItem>
      <ContentItemTitle info="How much space songs you play may take. Kept songs don't count. A smaller size removes the songs played longest ago until the cache fits.">
        Cache size
      </ContentItemTitle>
      <ContentItemForm className="flex items-center gap-2">
        {shown === 'custom' && (
          <div className="flex items-center gap-1">
            <Input
              className="h-8 w-20"
              inputMode="decimal"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={applyTyped}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyTyped()
              }}
            />
            <span className="text-sm text-muted-foreground">GB</span>
          </div>
        )}
        <Select
          value={shown}
          onValueChange={(value) => {
            if (value === 'custom') {
              setCustom(true)
              return
            }
            setCustom(false)
            setLimit(value === 'none' ? 0 : Number(value) * GB)
            if (value !== 'none') setTyped(value)
          }}
        >
          <SelectTrigger className="h-8 w-32 ring-offset-transparent focus:ring-0 focus:ring-transparent text-left">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectGroup>
              {PRESETS.map((gb) => (
                <SelectItem key={gb} value={String(gb)}>
                  {gb} GB
                </SelectItem>
              ))}
              <SelectItem value="none">No limit</SelectItem>
              <SelectItem value="custom">Other size…</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </ContentItemForm>
    </ContentItem>
  )
}

/** A button that asks once more before it acts. */
function ConfirmButton({
  label,
  onConfirm,
}: {
  label: string
  onConfirm: () => void
}) {
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    if (!asking) return
    const timer = setTimeout(() => setAsking(false), 4000)
    return () => clearTimeout(timer)
  }, [asking])

  return (
    <Button
      size="sm"
      variant={asking ? 'destructive' : 'outline'}
      onClick={() => {
        if (!asking) {
          setAsking(true)
          return
        }
        setAsking(false)
        onConfirm()
      }}
    >
      {asking ? 'Sure? Click again' : label}
    </Button>
  )
}
