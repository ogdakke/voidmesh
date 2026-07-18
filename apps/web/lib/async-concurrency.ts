export async function mapSettledWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input, index: number) => Promise<Output>,
): Promise<PromiseSettledResult<Output>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }

  const results = new Array<PromiseSettledResult<Output>>(inputs.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await mapper(inputs[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workerCount = Math.min(concurrency, inputs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
