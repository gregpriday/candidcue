import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Human label for the surface, e.g. "CandidCue" or "The teleprompter". */
  surface?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level React error boundary. A render-time throw anywhere below it is
 * caught and converted into a visible recovery surface instead of a blank
 * window. Self-contained (inline styles, no app tokens or CSS modules) so it
 * still renders when the styling layer is part of what failed.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[renderer] uncaught error', error, info.componentStack);
  }

  private readonly reload = (): void => {
    this.setState({ error: null });
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={overlayStyle}>
        <div style={cardStyle}>
          <h1 style={titleStyle}>Something went wrong</h1>
          <p style={bodyStyle}>
            {this.props.surface ?? 'CandidCue'} hit an unexpected error and stopped rendering. Your
            saved work is unaffected.
          </p>
          <pre style={detailStyle}>{error.message}</pre>
          <button type="button" style={buttonStyle} onClick={this.reload}>
            Reload interface
          </button>
        </div>
      </div>
    );
  }
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: '#0d0f12',
  color: '#f4f2ee',
  font: "14px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '40px',
};

const cardStyle: CSSProperties = { maxWidth: '480px', width: '100%' };

const titleStyle: CSSProperties = { fontSize: '18px', fontWeight: 650, margin: '0 0 12px' };

const bodyStyle: CSSProperties = { margin: '0 0 16px', color: '#b1b5bc' };

const detailStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: '#15181d',
  border: '1px solid #303640',
  borderRadius: '8px',
  padding: '12px',
  color: '#7d838d',
  fontSize: '12px',
  margin: '0 0 20px',
};

const buttonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid #414955',
  background: '#1b1f25',
  color: '#f4f2ee',
  borderRadius: '8px',
  padding: '8px 16px',
  fontSize: '14px',
  cursor: 'pointer',
};
