import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'react-toastify'
import { ROUTES } from '@/routes/routesList'
import { subsonic } from '@/service/subsonic'
import { SharedItemType } from '@/store/share-link.store'

interface OpenSharedItemProps {
  type: SharedItemType
}

/**
 * Landing route for share links (/album/<id> and friends). Sends the listener
 * to the matching page; a song opens its album with the track highlighted.
 */
export default function OpenSharedItem({ type }: OpenSharedItemProps) {
  const { itemId } = useParams<{ itemId: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()

  useEffect(() => {
    if (!itemId) {
      navigate(ROUTES.LIBRARY.HOME, { replace: true })
      return
    }

    if (type === 'album') {
      navigate(ROUTES.ALBUM.PAGE(itemId), { replace: true })
    } else if (type === 'artist') {
      navigate(ROUTES.ARTIST.PAGE(itemId), { replace: true })
    } else if (type === 'playlist') {
      navigate(ROUTES.PLAYLIST.PAGE(itemId), { replace: true })
    } else {
      let cancelled = false
      subsonic.songs
        .getSong(itemId)
        .catch(() => undefined)
        .then((song) => {
          if (cancelled) return
          if (song?.albumId) {
            const query = new URLSearchParams({
              [ROUTES.ALBUM.SONG_PARAM]: song.id,
            })
            navigate(`${ROUTES.ALBUM.PAGE(song.albumId)}?${query}`, {
              replace: true,
            })
          } else {
            toast.error(t('share.songNotFound'))
            navigate(ROUTES.LIBRARY.HOME, { replace: true })
          }
        })
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [type, itemId, navigate, t])

  return null
}
