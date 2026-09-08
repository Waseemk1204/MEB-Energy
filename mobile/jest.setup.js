/* eslint-env jest */

/**
 * Reanimated's worklets run on the UI thread, which does not exist under Jest.
 * Reanimated 4's own bundled mock still pulls in the real react-native-worklets
 * native module and throws, so this mock covers the small surface the app uses
 * and resolves every animation to its final value immediately — assertions then
 * see a settled needle rather than frame zero.
 */
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const settle = (v) => v;

  const createAnimatedComponent = (Component) =>
    React.forwardRef(function Animated({ animatedProps, ...rest }, ref) {
      return React.createElement(Component, { ...rest, ...(animatedProps || {}), ref });
    });

  return {
    __esModule: true,
    default: { View, Text: View, ScrollView: View, createAnimatedComponent },
    createAnimatedComponent,
    useSharedValue: (initial) => ({ value: initial }),
    useAnimatedProps: (fn) => fn(),
    useAnimatedStyle: (fn) => fn(),
    useDerivedValue: (fn) => ({ value: fn() }),
    useReducedMotion: () => false,
    withSpring: settle,
    withTiming: settle,
    withRepeat: settle,
    withDelay: (_ms, v) => v,
    runOnJS: (fn) => fn,
    Easing: { out: (fn) => fn, cubic: (t) => t, linear: (t) => t },
  };
});

/**
 * lucide-react-native ships ESM (.mjs) that jest-expo's transform does not pick
 * up. The icons are decorative — every one of them stands in as a plain View,
 * which also keeps the rendered trees small.
 */
jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === '__esModule') return true;
        return (props) => React.createElement(View, { ...props, testID: `icon-${String(name)}` });
      },
    }
  );
});

// expo-linear-gradient renders a native view; a plain View is enough for layout.
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: View };
});

// AsyncStorage backs the local audit log; an in-memory stand-in keeps screen
// tests from touching a real native module.
jest.mock('@react-native-async-storage/async-storage', () => {
  const mem = new Map();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k) => mem.get(k) ?? null),
      setItem: jest.fn(async (k, v) => {
        mem.set(k, v);
      }),
      removeItem: jest.fn(async (k) => {
        mem.delete(k);
      }),
      clear: jest.fn(async () => {
        mem.clear();
      }),
      getAllKeys: jest.fn(async () => [...mem.keys()]),
    },
  };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn(async (_alg, data) => `sha256:${data}`),
  getRandomBytes: jest.fn(() => new Uint8Array(16).fill(7)),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

// Fonts are already resolved by the time a screen renders in a test.
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: jest.fn(async () => undefined),
}));

jest.mock('react-native-safe-area-context', () => {
  const inset = { top: 44, right: 0, bottom: 34, left: 0 };
  const { View } = require('react-native');
  return {
    SafeAreaProvider: View,
    SafeAreaView: View,
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 375, height: 812 }),
  };
});
