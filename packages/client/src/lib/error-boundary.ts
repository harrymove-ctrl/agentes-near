import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children?: ReactNode;
  /** In place of `children` once one of them threw while drawing; `reset` draws them again. */
  fallback: (error: unknown, reset: () => void) => ReactNode;
  /** Besides the root's `onCaughtError`, which already gets every error a boundary catches. */
  onError?: (error: unknown, info: ErrorInfo) => void;
  /** A new value draws `children` again (a row's message that changed may draw fine now). */
  resetKey?: unknown;
}

/**
 * A render error below shows `fallback`, never an empty page: where no router's boundary reaches (the web app's
 * providers, the phone's screens outside its groups, the desktop app's windows), and round each row of a
 * conversation, so one that breaks is one quiet line. React's own class API: the package has no JSX.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean; error: unknown }> {
  override state = { failed: false, error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  // Not on the update that failed: the change that broke it may also be the new key, and it would only fail again.
  override componentDidUpdate(prev: ErrorBoundaryProps, prevState: { failed: boolean }) {
    if (prevState.failed && this.state.failed && !Object.is(prev.resetKey, this.props.resetKey)) this.reset();
  }

  reset = () => this.setState({ failed: false, error: undefined });

  override render() {
    return this.state.failed ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}
