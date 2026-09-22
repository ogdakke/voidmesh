function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

import { adjectives, nouns, verbs } from "#lib/files/filename-words.ts";

export function generateFunFilename(): string {
  return `${pick(adjectives)}-${pick(nouns)}-${pick(verbs)}.vdmsh`;
}
