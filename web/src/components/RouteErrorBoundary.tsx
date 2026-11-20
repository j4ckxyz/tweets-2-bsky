import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from './ui/button';

interface Props {
  /** Changing this (the current path) clears a caught error. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  resetKey: string;
}

// A page that throws while rendering shows a message in its place instead of
// blanking the whole dashboard; navigation and the sidebar keep working.
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Dashboard page failed to render.', error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="rounded-md border border-late/40 bg-late/[0.07] px-4 py-3 text-sm" role="alert">
        <p className="font-semibold text-late">This page could not be displayed.</p>
        <p className="mt-0.5 text-muted-foreground">
          {this.state.error.message || 'Something went wrong while rendering it.'}
        </p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
