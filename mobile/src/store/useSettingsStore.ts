import { create } from 'zustand';
import { profile, type BmsParameter } from '../bms/capabilityProfile';

/**
 * Live parameter values. Seeded from the capability profile's datasheet
 * defaults and updated only through the safe-write flow's read-back.
 */
type SettingsState = {
  values: Record<string, number>;
  setValue: (key: string, value: number) => void;
  /** Not named `valueOf` — that shadows Object.prototype and breaks the store's type. */
  currentValue: (param: BmsParameter) => number;
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  values: Object.fromEntries(profile.parameters.map((p) => [p.parameter_key, p.value])),

  setValue: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),

  currentValue: (param) => get().values[param.parameter_key] ?? param.value,
}));
