import clsx from 'clsx'
import { ArrowLeft, ImageOff, Loader2, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import { Button } from '@/app/components/ui/button'
import { Checkbox } from '@/app/components/ui/checkbox'
import { Input } from '@/app/components/ui/input'
import { Label } from '@/app/components/ui/label'
import { TagEdit, TaggerError, tagger } from '@/service/tagger'
import { ISong } from '@/types/responses/song'
import { fingerprintSong } from './fingerprint'
import {
  creditText,
  FingerprintChoice,
  fingerprintChoices,
  formats,
  MbRelease,
  MbReleaseSummary,
  matchTracks,
  releaseEdits,
  releaseTracks,
  searchQuery,
} from './musicbrainz'

export interface ReleaseChoice {
  release: MbRelease
  shared: TagEdit
  perSong: Record<string, TagEdit>
  /** The release's front cover (1200 px), when wanted and there is one. */
  cover: Blob | null
}

// Thumbnails stay for the session: browsing back and forth reuses them.
const thumbnails = new Map<string, Promise<string | null>>()

function thumbnail(id: string) {
  let url = thumbnails.get(id)
  if (!url) {
    // "No cover" is kept; a failed fetch is tried again next time.
    url = tagger
      .lookup(`coverart/release/${id}?size=250`)
      .then(async (res) =>
        res.ok ? URL.createObjectURL(await res.blob()) : null,
      )
      .catch(() => {
        thumbnails.delete(id)
        return null
      })
    thumbnails.set(id, url)
  }
  return url
}

function ReleaseThumb({ id, className }: { id: string; className?: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    thumbnail(id).then((url) => live && setSrc(url))
    return () => {
      live = false
    }
  }, [id])
  return (
    <div
      className={clsx(
        'shrink-0 rounded bg-muted border overflow-hidden flex items-center justify-center',
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" className="w-full h-full object-cover" />
      ) : src === null ? (
        <ImageOff className="h-4 w-4 text-muted-foreground" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
    </div>
  )
}

export type LookupMode = 'search' | 'identify'

interface LookupPanelProps {
  songs: ISong[]
  album: string
  artist: string
  /** Search by name, or identify the (one) song by its sound. */
  mode?: LookupMode
  onApply: (choice: ReleaseChoice) => void
  onBack: () => void
}

export function LookupPanel({
  songs,
  album: initialAlbum,
  artist: initialArtist,
  mode: initialMode = 'search',
  onApply,
  onBack,
}: LookupPanelProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<LookupMode>(initialMode)
  const [stage, setStage] = useState<'listening' | 'asking' | null>(null)
  const [matches, setMatches] = useState<FingerprintChoice[] | null>(null)
  const [album, setAlbum] = useState(initialAlbum)
  const [artist, setArtist] = useState(initialArtist)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<MbReleaseSummary[] | null>(null)
  const [release, setRelease] = useState<MbRelease | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [useCover, setUseCover] = useState(true)

  function fail(e: unknown) {
    const code = e instanceof TaggerError ? e.code : 'UPSTREAM_UNAVAILABLE'
    setError(
      t(`tagger.errors.${code}`, {
        ...(e instanceof TaggerError ? e.params : {}),
        defaultValue: t('tagger.errors.UPSTREAM_UNAVAILABLE'),
      }),
    )
  }

  async function search() {
    const query = searchQuery(album, artist)
    if (!query) return
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams({ query, limit: '15' })
      const res = await tagger.lookup(`musicbrainz/release?${params}`)
      const body = await res.json()
      setResults(body.releases ?? [])
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function identify(signal: AbortSignal) {
    setBusy(true)
    setError(null)
    try {
      setStage('listening')
      const { fingerprint, duration } = await fingerprintSong(songs[0], signal)
      setStage('asking')
      const results = await tagger.identify(fingerprint, duration)
      if (!signal.aborted) setMatches(fingerprintChoices(results))
    } catch (e) {
      if (!signal.aborted) fail(e)
    } finally {
      setStage(null)
      setBusy(false)
    }
  }

  // Searched at once: by what the songs say, or by the song's sound.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening a mode
  useEffect(() => {
    const controller = new AbortController()
    if (mode === 'identify') identify(controller.signal)
    else search()
    return () => controller.abort()
  }, [mode])

  async function pick(summary: MbReleaseSummary, recordingId?: string) {
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        inc: 'recordings artist-credits genres release-groups',
      })
      const res = await tagger.lookup(
        `musicbrainz/release/${summary.id}?${params}`,
      )
      const full = (await res.json()) as MbRelease
      // The recording the fingerprint found maps the song exactly.
      const known = recordingId ? { [songs[0].id]: recordingId } : {}
      setRelease(full)
      setMapping(matchTracks(songs, releaseTracks(full), known))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!release) return
    setBusy(true)
    let cover: Blob | null = null
    if (useCover) {
      try {
        const res = await tagger.lookup(
          `coverart/release/${release.id}?size=1200`,
        )
        if (res.ok) cover = await res.blob()
      } catch {
        // Applied without the cover.
      }
    }
    setBusy(false)
    if (useCover && !cover) toast.warning(t('tagger.lookup.noCover'))
    onApply({ release, ...releaseEdits(release, mapping), cover })
  }

  if (release) {
    const tracks = releaseTracks(release)
    const matched = Object.values(mapping).filter(Boolean).length
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-3">
          <ReleaseThumb id={release.id} className="w-16 h-16" />
          <div className="min-w-0">
            <p className="font-medium truncate">{release.title}</p>
            <p className="text-sm text-muted-foreground truncate">
              {[
                creditText(release['artist-credit']),
                release.date?.slice(0, 4),
                release.country,
                formats(release),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {t('tagger.lookup.matched', { matched, count: songs.length })}
          </p>
          <div className="rounded-md border divide-y">
            {songs.map((song) => (
              <div key={song.id} className="flex items-center gap-3 p-2">
                <span className="flex-1 min-w-0 truncate text-sm">
                  {song.title}
                </span>
                <select
                  className="w-1/2 h-8 rounded-md border bg-background px-2 text-sm"
                  value={mapping[song.id] ?? ''}
                  onChange={(e) =>
                    setMapping((m) => ({
                      ...m,
                      [song.id]: e.target.value || null,
                    }))
                  }
                >
                  <option value="">{t('tagger.lookup.leave')}</option>
                  {tracks.map((track) => (
                    <option key={track.key} value={track.key}>
                      {track.discTotal > 1 ? `${track.disc}-` : ''}
                      {String(track.number).padStart(2, '0')} {track.title}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <Checkbox
            checked={useCover}
            onCheckedChange={(v) => setUseCover(v === true)}
          />
          {t('tagger.lookup.useCover')}
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={() => setRelease(null)}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('tagger.lookup.otherRelease')}
          </Button>
          <Button onClick={apply} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('tagger.lookup.apply')}
          </Button>
        </div>
      </div>
    )
  }

  if (mode === 'identify') {
    return (
      <div className="p-6 space-y-4">
        {stage && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t(`tagger.identify.${stage}`)}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {matches && matches.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('tagger.identify.nothing')}
          </p>
        )}
        {matches && matches.length > 0 && (
          <div className="rounded-md border divide-y">
            {matches.map((m) => (
              <button
                key={m.release.id}
                type="button"
                className="w-full flex items-center gap-3 p-2 text-left hover:bg-accent disabled:opacity-50"
                onClick={() => pick(m.release, m.recordingId)}
                disabled={busy}
              >
                <ReleaseThumb id={m.release.id} className="w-12 h-12" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {m.release.title}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {[
                      creditText(m.release['artist-credit']),
                      m.release.date,
                      m.release.country,
                      m.release['track-count'] &&
                        t('tagger.lookup.tracks', {
                          count: m.release['track-count'],
                        }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {t('tagger.identify.match', {
                      title: m.recordingTitle,
                      score: Math.round(m.score * 100),
                    })}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={onBack} disabled={!!stage}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('tagger.lookup.back')}
          </Button>
          {!stage && (
            <Button variant="outline" onClick={() => setMode('search')}>
              <Search className="mr-2 h-4 w-4" />
              {t('tagger.identify.byName')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <form
        className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end"
        onSubmit={(e) => {
          e.preventDefault()
          search()
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="mb-album" className="text-xs">
            {t('tagger.fields.album')}
          </Label>
          <Input
            id="mb-album"
            value={album}
            onChange={(e) => setAlbum(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mb-artist" className="text-xs">
            {t('tagger.fields.artist')}
          </Label>
          <Input
            id="mb-artist"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy || !searchQuery(album, artist)}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          <span className="sr-only">{t('tagger.lookup.search')}</span>
        </Button>
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {results && results.length === 0 && !busy && (
        <p className="text-sm text-muted-foreground">
          {t('tagger.lookup.nothing')}
        </p>
      )}

      {results && results.length > 0 && (
        <div className="rounded-md border divide-y">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              className="w-full flex items-center gap-3 p-2 text-left hover:bg-accent disabled:opacity-50"
              onClick={() => pick(r)}
              disabled={busy}
            >
              <ReleaseThumb id={r.id} className="w-12 h-12" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{r.title}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {[
                    creditText(r['artist-credit']),
                    r.date?.slice(0, 4),
                    r.country,
                    formats(r),
                    t('tagger.lookup.tracks', { count: r['track-count'] ?? 0 }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        {t('tagger.lookup.back')}
      </Button>
    </div>
  )
}
