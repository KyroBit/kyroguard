export type KyroguardErrorCode =
  | 'UNAUTHENTICATED'
  | 'ACCESS_DENIED'
  | 'NOT_FOUND'
  | 'MISCONFIGURED'

/** Distinguishes the two ACCESS_DENIED denials in error bodies. */
export type AccessDeniedReason = 'policy' | 'scope'

export interface KyroguardErrorBody {
  message: string
  code: KyroguardErrorCode
  /** Present only when `code` is ACCESS_DENIED. */
  reason?: AccessDeniedReason
}

export abstract class KyroguardError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: KyroguardErrorCode
  /** Set only by the ACCESS_DENIED errors. */
  readonly reason?: AccessDeniedReason

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }

  /** Default response body. Frameworks may override via formatError. */
  toBody(): KyroguardErrorBody {
    return this.code === 'ACCESS_DENIED' && this.reason
      ? { message: this.message, code: this.code, reason: this.reason }
      : { message: this.message, code: this.code }
  }
}

/** No subject on the request — authentication missing or failed. → 401 */
export class UnauthenticatedError extends KyroguardError {
  readonly statusCode = 401
  readonly code = 'UNAUTHENTICATED'

  constructor(message = 'Unauthorized') {
    super(message)
  }
}

/** Subject lacks the required policy in this domain + tenant. → 403 */
export class PolicyDeniedError extends KyroguardError {
  readonly statusCode = 403
  readonly code = 'ACCESS_DENIED'
  override readonly reason = 'policy'

  constructor(
    readonly policy: string,
    message = 'Forbidden',
  ) {
    super(message)
  }
}

/** Policy granted but the scope check rejected this resource. → 403 */
export class ScopeDeniedError extends KyroguardError {
  readonly statusCode = 403
  readonly code = 'ACCESS_DENIED'
  override readonly reason = 'scope'

  constructor(
    readonly policy: string,
    readonly scope: string,
    message = 'Forbidden',
  ) {
    super(message)
  }
}

/** Scoped guard could not resolve the target resource. → 404 */
export class ResourceNotFoundError extends KyroguardError {
  readonly statusCode = 404
  readonly code = 'NOT_FOUND'

  constructor(message = 'Not found') {
    super(message)
  }
}

/** Library wired incorrectly (developer error, not a request outcome). → 500 */
export class MisconfiguredError extends KyroguardError {
  readonly statusCode = 500
  readonly code = 'MISCONFIGURED'
}
