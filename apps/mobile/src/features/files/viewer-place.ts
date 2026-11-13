/**
 * The picture viewer is a route of its own, so what it tells the stack it opened from goes through here: the stack
 * listens under its key, passed to the viewer as `from`, and comes back on the picture the person stopped at.
 */
const listeners = new Map<string, (at: number) => void>();

export function listenViewerPlace(key: string, listener: (at: number) => void) {
  listeners.set(key, listener);
  return () => {
    listeners.delete(key);
  };
}

export const tellViewerPlace = (key: string, at: number) => listeners.get(key)?.(at);
