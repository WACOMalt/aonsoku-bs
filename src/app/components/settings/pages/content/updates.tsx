import {
  Content,
  ContentItem,
  ContentItemForm,
  ContentItemTitle,
  Header,
  HeaderDescription,
  HeaderTitle,
  Root,
} from '@/app/components/settings/section'
import { Button } from '@/app/components/ui/button'
import { Switch } from '@/app/components/ui/switch'
import { CheckForUpdates } from '@/app/components/update/check-for-updates'
import { useUpdatePrefs } from '@/store/update.store'
import { getAppInfo } from '@/utils/appName'

/** Update checks for the desktop and Android apps (see utils/appUpdate.ts). */
export function UpdatesContent() {
  const { autoCheck, setAutoCheck, skippedVersion, setSkippedVersion } =
    useUpdatePrefs()

  return (
    <Root>
      <Header>
        <HeaderTitle>Updates</HeaderTitle>
        <HeaderDescription>
          This is version {getAppInfo().version}. New versions come from the
          releases on GitHub.
        </HeaderDescription>
      </Header>
      <Content>
        <ContentItem>
          <ContentItemTitle info="Looks for a newer version in the background each time Aonsoku starts, and offers it if there is one.">
            Check for updates when Aonsoku starts
          </ContentItemTitle>
          <ContentItemForm>
            <Switch checked={autoCheck} onCheckedChange={setAutoCheck} />
          </ContentItemForm>
        </ContentItem>
        {skippedVersion && (
          <ContentItem>
            <ContentItemTitle>
              Ignoring version {skippedVersion}
            </ContentItemTitle>
            <ContentItemForm>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSkippedVersion(null)}
              >
                Stop ignoring
              </Button>
            </ContentItemForm>
          </ContentItem>
        )}
        <ContentItem>
          <ContentItemTitle>Check now</ContentItemTitle>
          <ContentItemForm>
            <CheckForUpdates />
          </ContentItemForm>
        </ContentItem>
      </Content>
    </Root>
  )
}
