import { LanguagePage } from "@/features/me/PreferencePages";

/** The language before signing in: kept on the phone and sent at the next sign-in. */
export default function SignedOutLanguage() {
  return <LanguagePage signedIn={false} />;
}
