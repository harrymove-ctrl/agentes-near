/**
 * The address a sign-up on this phone was just emailed a link to confirm (a server that sends email sends it), so the
 * first run's workspace step can say where it went. Kept in memory only, as the web keeps it for the tab: a later
 * first run (another workspace, another day) says nothing of it.
 */
let sentTo: string | null = null;

export function rememberConfirmationSent(email: string) {
  sentTo = email.trim().toLowerCase();
}

export const confirmationSentTo = () => sentTo;

export function forgetConfirmationSent() {
  sentTo = null;
}
