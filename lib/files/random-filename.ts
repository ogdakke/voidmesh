function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export async function generateFunFilename(): Promise<string> {
  const { adjectives, nouns, verbs } = await import("#lib/files/filename-words.ts");
  return `${pick(adjectives)}-${pick(nouns)}-${pick(verbs)}.vdmsh`;
}
