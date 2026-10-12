import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ImageIcon, Loader2, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import { getSimpleCoverArtUrl } from '@/api/httpClient'
import { Button } from '@/app/components/ui/button'
import { Checkbox } from '@/app/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog'
import { Input } from '@/app/components/ui/input'
import { Label } from '@/app/components/ui/label'
import { ScrollArea } from '@/app/components/ui/scroll-area'
import {
  CoverUpload,
  TAG_FIELDS,
  TagField,
  TaggerError,
  tagger,
} from '@/service/tagger'
import { useTaggerActions, useTaggerStore } from '@/store/tagger.store'
import { ISong } from '@/types/responses/song'
import { buildItems, initialValues, isEditable, validate } from './fields'

// Navidrome needs a moment to rescan the edited folders.
const REFRESH_AFTER_MS = [1500, 6000]

interface Failure {
  title: string
  error: string
}

export function EditTagsDialog() {
  const songs = useTaggerStore((state) => state.editing)
  const fromAlbum = useTaggerStore((state) => state.fromAlbum)
  const { closeEditor } = useTaggerActions()
  const open = songs.length > 0

  return (
    <Dialog open={open} onOpenChange={(value) => !value && closeEditor()}>
      {open && (
        <EditTagsForm
          // A new selection starts a fresh form.
          key={songs.map((s) => s.id).join(',')}
          songs={songs}
          fromAlbum={fromAlbum}
          onDone={closeEditor}
        />
      )}
    </Dialog>
  )
}

function EditTagsForm({
  songs,
  fromAlbum,
  onDone,
}: {
  songs: ISong[]
  fromAlbum: boolean
  onDone: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const initial = useMemo(() => initialValues(songs), [songs])
  const [changed, setChanged] = useState<Partial<Record<TagField, string>>>({})
  const [cover, setCover] = useState<CoverUpload | null>(null)
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [folderCover, setFolderCover] = useState(true)
  const [saving, setSaving] = useState(false)
  const [failures, setFailures] = useState<Failure[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (coverPreview) URL.revokeObjectURL(coverPreview)
    }
  }, [coverPreview])

  const batch = songs.length > 1
  const errors = Object.fromEntries(
    Object.entries(changed).map(([field, value]) => [
      field,
      validate(field as TagField, value ?? ''),
    ]),
  ) as Partial<Record<TagField, string | null>>
  const hasErrors = Object.values(errors).some(Boolean)
  const items = buildItems(songs, changed, cover)

  function setField(field: TagField, value: string) {
    setChanged((previous) => {
      const next = { ...previous }
      // Back to what it was: not a change. Emptying a field the songs
      // differ in leaves it as it is (it would clear it for them all).
      const unchanged =
        initial[field] === null ? value === '' : value === initial[field]
      if (unchanged) {
        delete next[field]
      } else {
        next[field] = value
      }
      return next
    })
  }

  function resetField(field: TagField) {
    setChanged((previous) => {
      const next = { ...previous }
      delete next[field]
      return next
    })
  }

  async function pickCover(file: File | undefined) {
    if (!file) return
    try {
      setCover(await tagger.coverFromFile(file))
      setCoverPreview(URL.createObjectURL(file))
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  function errorText(error: unknown) {
    const code = error instanceof TaggerError ? error.code : 'WRITE_FAILED'
    return t(`tagger.errors.${code}`, {
      defaultValue: t('tagger.errors.WRITE_FAILED'),
    })
  }

  async function save() {
    setSaving(true)
    setFailures([])
    try {
      const { results } = await tagger.write(items, folderCover && !!cover)
      const failed = results.filter((r) => !r.ok)
      const saved = results.length - failed.length
      if (saved > 0) {
        toast.success(t('tagger.saved', { count: saved }))
        // Navidrome rescans the edited folders; show what it reads back.
        for (const delay of REFRESH_AFTER_MS) {
          setTimeout(() => queryClient.invalidateQueries(), delay)
        }
      }
      if (failed.length === 0) {
        onDone()
        return
      }
      setFailures(
        failed.map((r) => ({
          title: songs.find((s) => s.id === r.songId)?.title ?? r.songId,
          error: errorText(new TaggerError(r.error ?? 'WRITE_FAILED')),
        })),
      )
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  const first = songs[0]
  const currentCover = getSimpleCoverArtUrl(first.coverArt, 'album', '300')

  return (
    <DialogContent className="max-w-[640px] p-0 gap-0 overflow-hidden">
      <DialogHeader className="border-b p-6">
        <DialogTitle>{t('tagger.title')}</DialogTitle>
        <DialogDescription className="truncate">
          {batch
            ? t('tagger.songCount', { count: songs.length })
            : [first.title, first.displayArtist || first.artist]
                .filter(Boolean)
                .join(' – ')}
        </DialogDescription>
      </DialogHeader>

      <ScrollArea className="max-h-[min(70vh,600px)]">
        <div className="flex flex-col sm:flex-row gap-6 p-6">
          <div className="flex flex-col items-center gap-2 sm:w-40 shrink-0">
            <div className="relative w-40 h-40 rounded-md overflow-hidden bg-muted border">
              <img
                src={coverPreview ?? currentCover}
                alt=""
                className="w-full h-full object-cover"
              />
              {cover && (
                <span className="absolute top-1 left-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                  {t('tagger.cover.new')}
                </span>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                pickCover(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => fileInput.current?.click()}
            >
              <ImageIcon className="mr-2 h-4 w-4" />
              {t('tagger.cover.choose')}
            </Button>
            {cover && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    setCover(null)
                    setCoverPreview(null)
                  }}
                >
                  {t('tagger.cover.keep')}
                </Button>
                <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox
                    checked={folderCover}
                    onCheckedChange={(v) => setFolderCover(v === true)}
                    className="mt-0.5"
                  />
                  <span>
                    {t(
                      fromAlbum || batch
                        ? 'tagger.cover.folder'
                        : 'tagger.cover.folderSingle',
                    )}
                  </span>
                </label>
              </>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 flex-1 content-start">
            {TAG_FIELDS.map((field) => {
              const editable = isEditable(field, songs.length)
              const isChanged = field in changed
              const value = changed[field] ?? initial[field] ?? ''
              const wide = field === 'title' || field === 'album'
              return (
                <div
                  key={field}
                  className={clsx('space-y-1', wide && 'sm:col-span-2')}
                >
                  <div className="flex items-center justify-between h-5">
                    <Label htmlFor={`tag-${field}`} className="text-xs">
                      {t(`tagger.fields.${field}`)}
                    </Label>
                    {isChanged && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => resetField(field)}
                        title={t('tagger.reset')}
                        aria-label={t('tagger.reset')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <Input
                    id={`tag-${field}`}
                    value={value}
                    disabled={!editable || saving}
                    placeholder={
                      !editable
                        ? t('tagger.perSong')
                        : initial[field] === null
                          ? t('tagger.multipleValues')
                          : undefined
                    }
                    onChange={(e) => setField(field, e.target.value)}
                    className={clsx(
                      'h-9',
                      errors[field]
                        ? 'border-destructive ring-1 ring-destructive'
                        : isChanged && 'border-primary ring-1 ring-primary',
                    )}
                  />
                  {errors[field] && (
                    <p className="text-xs text-destructive">
                      {t(errors[field] as string)}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {failures.length > 0 && (
          <div className="mx-6 mb-6 rounded-md border border-destructive/50 p-3 text-sm">
            <p className="font-medium mb-1">
              {t('tagger.failed', { count: failures.length })}
            </p>
            <ul className="space-y-0.5 text-muted-foreground">
              {failures.map((f) => (
                <li key={f.title} className="truncate">
                  {f.title}: {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </ScrollArea>

      <DialogFooter className="border-t p-4 gap-2">
        <Button variant="ghost" onClick={onDone} disabled={saving}>
          {t('tagger.cancel')}
        </Button>
        <Button
          onClick={save}
          disabled={saving || hasErrors || items.length === 0}
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {saving ? t('tagger.saving') : t('tagger.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
