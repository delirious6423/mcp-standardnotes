/** Thrown when a commit stops before anything was sent: the approved operation can be retried as is. */
export class NothingSentError extends Error {
  override name = "NothingSentError";
}

export function nothingSent(error: unknown): NothingSentError {
  if (error instanceof NothingSentError) return error;
  return new NothingSentError(error instanceof Error ? error.message : String(error), { cause: error });
}
