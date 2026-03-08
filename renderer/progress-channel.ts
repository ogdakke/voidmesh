/**
 * Async generator-based progress channel.
 *
 * Provides a push-based emit API that feeds an async pull-based generator.
 * Used by frame-encoder, video-exporter (RVFC + GIF lazy) to decouple
 * progress producers from consumers.
 */

export interface ProgressChannel<T> {
  /** Push a progress value to the consumer */
  emit: (value: T) => void;
  /** Wake the generator without emitting (e.g. on cancel) */
  wake: () => void;
  /** Create the async generator. Call once per channel. */
  generator: () => AsyncGenerator<T>;
}

/**
 * Create a progress channel that bridges push-based emitters to an async generator.
 *
 * @param isDone - Predicate: returns true when the emitted value signals completion
 * @param isCancelled - Returns true when the consumer should stop iterating
 */
export function createProgressChannel<T>(
  isDone: (value: T) => boolean,
  isCancelled: () => boolean,
): ProgressChannel<T> {
  const queue: T[] = [];
  let resolve: (() => void) | null = null;

  function emit(value: T): void {
    queue.push(value);
    if (resolve) {
      resolve();
      resolve = null;
    }
  }

  function wake(): void {
    if (resolve) {
      resolve();
      resolve = null;
    }
  }

  async function* generator(): AsyncGenerator<T> {
    while (true) {
      if (isCancelled()) return;

      if (queue.length > 0) {
        const value = queue.shift()!;
        yield value;
        if (isDone(value)) return;
      } else {
        await new Promise<void>((r) => {
          resolve = r;
        });
        if (isCancelled()) return;
      }
    }
  }

  return { emit, wake, generator };
}
