export type GuardErrorCode = 'UNAUTHENTICATED' | 'ACCESS_DENIED' | 'MISCONFIGURED'

export interface GuardErrorBody {
  message: string
  code: GuardErrorCode
}

export abstract class GuardError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: GuardErrorCode

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }

  /** Default response body. Frameworks may override via formatError. */
  toBody(): GuardErrorBody {
    return { message: this.message, code: this.code }
  }
}

/** No subject on the request — authentication missing or failed. → 401 */
export class UnauthenticatedError extends GuardError {
  readonly statusCode = 401
  readonly code = 'UNAUTHENTICATED'

  constructor(message = 'Unauthorized') {
    super(message)
  }
}

/** Subject lacks the required policy in this domain + tenant. → 403 */
export class PolicyDeniedError extends GuardError {
  readonly statusCode = 403
  readonly code = 'ACCESS_DENIED'

  constructor(
    readonly policy: string,
    message = 'Forbidden',
  ) {
    super(message)
  }
}

/** Library wired incorrectly (developer error, not a request outcome). → 500 */
export class MisconfiguredError extends GuardError {
  readonly statusCode = 500
  readonly code = 'MISCONFIGURED'
}
