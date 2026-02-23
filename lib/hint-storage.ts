// localStorage utilities for hint dismissals
const STORAGE_KEY = "studio-hints-dismissed";

interface DismissedHints {
  [key: string]: boolean;
}

export function getHintDismissed(key: string): boolean {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return false;
    const dismissed: DismissedHints = JSON.parse(data);
    return dismissed[key] === true;
  } catch {
    return false;
  }
}

export function setHintDismissed(key: string): void {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    const dismissed: DismissedHints = data ? JSON.parse(data) : {};
    dismissed[key] = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dismissed));
  } catch (err) {
    console.error("Failed to save hint dismissal:", err);
  }
}

export function clearAllHintDismissals(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error("Failed to clear hint dismissals:", err);
  }
}
