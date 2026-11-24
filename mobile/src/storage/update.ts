import AsyncStorage from '@react-native-async-storage/async-storage';

const IGNORED_VERSION_KEY = 'jiancang:ignored-update-version:v1';

/** Best-effort persistence: update preferences must never break the app. */
export async function loadIgnoredUpdateVersion(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(IGNORED_VERSION_KEY);
    const value = stored?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export async function saveIgnoredUpdateVersion(version: string): Promise<void> {
  const value = version.trim();
  if (!value) return;
  try {
    await AsyncStorage.setItem(IGNORED_VERSION_KEY, value);
  } catch {
    // Ignoring a version is a convenience; failing to persist is non-fatal.
  }
}

export async function clearIgnoredUpdateVersion(): Promise<void> {
  try {
    await AsyncStorage.removeItem(IGNORED_VERSION_KEY);
  } catch {
    // Best effort only.
  }
}
