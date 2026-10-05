import { getUpdateSource } from '@/utils/appUpdate'
import { CachesContent } from './caches'
import { FeatureContent } from './features'
import { HomeContent } from './home'
import { PodcastContent } from './podcast'
import { SidebarContent } from './sidebar'
import { SyncServerContent } from './sync-server'
import { UpdatesContent } from './updates'

export function Content() {
  return (
    <div className="space-y-4">
      <HomeContent />
      <SidebarContent />
      <FeatureContent />
      <PodcastContent />
      <SyncServerContent />
      <CachesContent />
      {getUpdateSource() && <UpdatesContent />}
    </div>
  )
}
