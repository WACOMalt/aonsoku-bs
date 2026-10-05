import { RouterProvider } from 'react-router-dom'
import { Linux } from '@/app/components/controls/linux'
import { SettingsDialog } from '@/app/components/settings/dialog'
import { LangObserver } from '@/app/observers/lang-observer'
import { MediaSessionObserver } from '@/app/observers/media-session-observer'
import { ThemeObserver } from '@/app/observers/theme-observer'
import { ToastContainer } from '@/app/observers/toast-container'
import { UpdateObserver } from '@/app/observers/update-observer'
import { router } from '@/routes/router'
import { getUpdateSource } from '@/utils/appUpdate'
import { isLinux } from '@/utils/desktop'

function App() {
  return (
    <>
      {getUpdateSource() && <UpdateObserver />}
      <MediaSessionObserver />
      <LangObserver />
      <ThemeObserver />
      <SettingsDialog />
      <RouterProvider router={router} />
      <ToastContainer />
      {isLinux && <Linux />}
    </>
  )
}

export default App
