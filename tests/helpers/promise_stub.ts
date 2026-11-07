/** Model an async test interface with immediate work and rejected synchronous errors. */
export function promiseStub<Args extends unknown[], Result>(
  implementation: (...args: Args) => Result | PromiseLike<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) =>
    new Promise(resolve => {
      // The executor runs immediately and the Promise constructor captures throws.
      resolve(implementation(...args));
    });
}
