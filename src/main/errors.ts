/** A request named something (e.g. a command) that does not exist. */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError'
}
