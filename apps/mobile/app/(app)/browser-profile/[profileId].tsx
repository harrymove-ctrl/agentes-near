import { useLocalSearchParams } from "expo-router";
import { ProfileLoginScreen } from "@/features/browser/ProfileLoginScreen";
import { FocusLive } from "@/features/shared/parts";

/** A shared browser profile's live view, full screen ("Fazer login" from a computer's page). */
export default function BrowserProfileRoute() {
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  return (
    <FocusLive>
      <ProfileLoginScreen key={profileId} profileId={profileId} />
    </FocusLive>
  );
}
