interface PendingPermit {
  byteLength: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}

export class AssetTransferLimiter {
  readonly #maxConcurrent: number;
  readonly #maxBytes: number;
  readonly #pending: PendingPermit[] = [];
  #active = 0;
  #activeBytes = 0;
  #cancelled: Error | null = null;

  constructor(maxConcurrent: number, maxBytes: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("Asset transfer concurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Asset transfer byte limit must be a positive integer");
    }
    this.#maxConcurrent = maxConcurrent;
    this.#maxBytes = maxBytes;
  }

  acquire(byteLength: number): Promise<() => void> {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      return Promise.reject(new Error("Asset transfer size must be a non-negative integer"));
    }
    if (this.#cancelled) return Promise.reject(this.#cancelled);
    return new Promise((resolve, reject) => {
      this.#pending.push({ byteLength, resolve, reject });
      this.#drain();
    });
  }

  cancel(error: Error): void {
    if (this.#cancelled) return;
    this.#cancelled = error;
    for (const permit of this.#pending.splice(0)) permit.reject(error);
  }

  #drain(): void {
    while (this.#pending.length > 0 && this.#active < this.#maxConcurrent) {
      const next = this.#pending[0]!;
      if (this.#active > 0 && this.#activeBytes + next.byteLength > this.#maxBytes) return;
      this.#pending.shift();
      this.#active++;
      this.#activeBytes += next.byteLength;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.#active--;
        this.#activeBytes -= next.byteLength;
        this.#drain();
      });
    }
  }
}
