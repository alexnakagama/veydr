/** A request named something (e.g. a command) that does not exist. */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError'
}

/** A lifecycle action was refused because Veydr is quitting (design D10). */
export class ShuttingDownError extends Error {
  override readonly name = 'ShuttingDownError'
}

/** A well-formed request was refused; `message` tells the user why (API error code `rejected`). */
export class UserError extends Error {
  override readonly name = 'UserError'
}
