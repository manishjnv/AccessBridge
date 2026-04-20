export { ProfileStore } from './store.js';

// --- Priority 3: Profile versioning + drift detection ---
export {
  ProfileVersionStore,
  InMemoryKeyValueStore,
  diffProfiles,
  VERSIONS_STORAGE_KEY,
  DEFAULT_VERSION_CAP,
} from './versioning.js';
export type { ProfileVersion, KeyValueStore, ProfileDiffEntry } from './versioning.js';

export { detectDrift, DEFAULT_METRICS, DEFAULT_DRIFT_WINDOW_MS } from './drift-detector.js';
export type {
  DriftFinding,
  DriftReport,
  TrendDirection,
  NumericMetricConfig,
} from './drift-detector.js';
