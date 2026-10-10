import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogTitle } from '@/app/components/ui/dialog'
import { ScrollArea } from '@/app/components/ui/scroll-area'
import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
} from '@/app/components/ui/sidebar'
import { useIsMobile } from '@/app/hooks/use-mobile'
import { useAppSettings } from '@/store/app.store'
import { SettingsBreadcrumb } from './breadcrumb'
import { SettingsOptions } from './options'
import { Pages } from './pages'

export function SettingsDialog() {
  const { t } = useTranslation()
  const { openDialog, setOpenDialog } = useAppSettings()
  const isMobile = useIsMobile()
  const [showCategoryList, setShowCategoryList] = useState(true)

  // Reset to category list when dialog opens on mobile
  useEffect(() => {
    if (openDialog && isMobile) {
      setShowCategoryList(true)
    }
  }, [openDialog, isMobile])

  const handleCategorySelect = useCallback(() => {
    if (isMobile) {
      setShowCategoryList(false)
    }
  }, [isMobile])

  const handleBack = useCallback(() => {
    setShowCategoryList(true)
  }, [])

  return (
    <Dialog open={openDialog} onOpenChange={setOpenDialog}>
      <DialogContent
        className={
          isMobile
            ? 'overflow-hidden p-0 h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw]'
            : 'overflow-hidden p-0 h-[500px] max-h-[600px] max-w-3xl 2xl:h-[600px] 2xl:max-h-[700px] 2xl:max-w-4xl'
        }
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{t('settings.label')}</DialogTitle>

        {isMobile ? (
          /* Mobile layout: two-panel navigation. SettingsOptions renders
             SidebarMenuButton, which needs a SidebarProvider; without one it
             throws and the whole app unmounts. */
          <SidebarProvider className="min-h-0 h-full min-w-0">
            <div className="flex flex-col h-full w-full overflow-hidden bg-background-foreground">
              {showCategoryList ? (
                /* Mobile: Category list view */
                <div className="flex flex-col h-full">
                  <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                    <h2 className="text-lg font-semibold">
                      {t('settings.label')}
                    </h2>
                  </header>
                  <ScrollArea className="flex-1 overflow-hidden">
                    <SettingsOptions onCategorySelect={handleCategorySelect} />
                  </ScrollArea>
                </div>
              ) : (
                /* Mobile: Settings page view with back navigation */
                <div className="flex flex-col h-full">
                  <SettingsBreadcrumb onBack={handleBack} />
                  <ScrollArea className="flex-1 overflow-hidden">
                    <div className="w-full h-full gap-4 p-4 pt-0">
                      <Pages />
                    </div>
                  </ScrollArea>
                </div>
              )}
            </div>
          </SidebarProvider>
        ) : (
          /* Desktop layout: sidebar + content (unchanged) */
          <SidebarProvider className="min-h-full min-w-0">
            <Sidebar collapsible="none" className="hidden md:flex">
              <SidebarContent>
                <SettingsOptions />
              </SidebarContent>
            </Sidebar>
            <main className="flex flex-1 flex-col overflow-hidden bg-background-foreground">
              <SettingsBreadcrumb />
              <ScrollArea className="overflow-hidden">
                <div className="w-full h-full gap-4 p-4 pt-0">
                  <Pages />
                </div>
              </ScrollArea>
            </main>
          </SidebarProvider>
        )}
      </DialogContent>
    </Dialog>
  )
}
