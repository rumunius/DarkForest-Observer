/** Bridge async work to DOM callbacks and send failures to the caller's UI feedback. */
export function handleAsync<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown>,
  onError: (error: unknown) => void,
): (...args: Args) => void {
  return (...args) => {
    try {
      void action(...args).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
}
