import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:history-page-preferences:v1";
const HistoryPagePreferencesSchema = Schema.Struct({
  windowDays: Schema.Literals([7, 30, 90]),
});
export type HistoryPagePreferences = typeof HistoryPagePreferencesSchema.Type;

const DEFAULT_PREFERENCES: HistoryPagePreferences = { windowDays: 30 };

export function readHistoryPagePreferences(): HistoryPagePreferences {
  try {
    return getLocalStorageItem(STORAGE_KEY, HistoryPagePreferencesSchema) ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Could not read History page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveHistoryPagePreferences(preferences: HistoryPagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, HistoryPagePreferencesSchema);
  } catch (error) {
    console.error("Could not save History page preferences.", error);
  }
}
