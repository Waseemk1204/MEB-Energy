import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radii } from '../theme/tokens';
import { type as T } from '../theme/type';
import { PrimaryButton } from './primitives';
import { reportError } from '../diagnostics/reporter';

/**
 * Keeps one broken screen from taking the app down.
 *
 * A technician mid-diagnosis at a live pack needs a way back to a working
 * screen, not a blank phone. Recovery is a real remount rather than a reload,
 * so the BLE session and the telemetry stream survive the error.
 */

interface Props {
  /** Named in the report, so a crash says which screen produced it. */
  scope: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  /** Bumping this remounts the subtree, discarding the broken render. */
  attempt: number;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError(error, {
      scope: this.props.scope,
      detail: { componentStack: (info.componentStack ?? '').slice(0, 500) },
    });
  }

  private retry = () => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    if (this.state.error) {
      return <ErrorFallback scope={this.props.scope} error={this.state.error} onRetry={this.retry} />;
    }
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}

function ErrorFallback({
  scope,
  error,
  onRetry,
}: {
  scope: string;
  error: Error;
  onRetry: () => void;
}) {
  const { p } = useTheme();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.panelBase }}
      contentContainerStyle={styles.wrap}
    >
      <View style={[styles.card, { backgroundColor: p.panelAlt, borderLeftColor: p.critical }]}>
        <Text style={[T.screenTitle, { color: p.inkStrong, fontSize: 20 }]}>
          This screen stopped working
        </Text>
        <Text style={[T.body, { color: p.inkSoft, marginTop: 10 }]}>
          The rest of the app is unaffected, and your connection to the battery is still open.
          Nothing was written.
        </Text>
        <Text style={[T.caption, { color: p.inkFaint, marginTop: 14 }]}>
          {scope} — {error.message}
        </Text>
      </View>

      <View style={{ marginTop: 20 }}>
        <PrimaryButton label="Try again" onPress={onRetry} />
      </View>

      <Text style={[T.caption, { color: p.inkFaint, marginTop: 16, textAlign: 'center' }]}>
        If it keeps happening, export the diagnostic log from Help and send it with a description
        of what you were doing.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  card: { borderLeftWidth: 4, borderRadius: radii.card, padding: 20 },
});
