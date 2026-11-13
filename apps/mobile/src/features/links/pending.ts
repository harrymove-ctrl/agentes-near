/**
 * A web link opened while signed out (`app/+native-intent.tsx`): the sign-in comes first, then the link
 * (`app/_layout.tsx`). Signing out drops it, so a link opened earlier never reopens on the next sign-in.
 */
let pending: string | null = null;

export const rememberLink = (href: string) => {
  pending = href;
};

export const takeLink = () => {
  const href = pending;
  pending = null;
  return href;
};
