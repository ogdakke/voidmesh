export function uniqueId() {
  return Math.random().toString(36).substring(2, 9);
}

export function optionsWithNull<T extends { value: any; label: string }[]>(config: {
  options: T;
  nullLabel?: string;
}): { value: T[number]["value"] | null; label: string }[] {
  const { options, nullLabel = "Select value" } = config;

  return [
    { value: null, label: nullLabel },
    ...options.map(({ value, label }) => ({ value, label })),
  ];
}
