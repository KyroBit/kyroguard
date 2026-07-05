/**
 * Typed authorization errors.
 *
 * Core never writes HTTP responses. Guards throw these; each framework
 * integration surfaces them through the framework's own error pipeline
 * (Fastify: thrown → error handler, onSend hooks and CORS all run;
 * Express: next(err) → rbacErrorHandler()). Every error carries a stable
 * machine-readable `code` documented in the error reference.
 */

export type RbacErrorCode =
  | 'RBAC_UNAUTHENTICATED'
  | 'RBAC_POLICY_DENIED'
  | 'RBAC_SCOPE_DENIED'
  | 'RBAC_RESOURCE_NOT_FOUND'
  | 'RBAC_MISCONFIGURED'

export abstract class RbacError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: RbacErrorCode

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }

  /** Default response body. Frameworks may override via formatError. */
  toBody(): { message: string; code: RbacErrorCode } {
    return { message: this.message, code: this.code }
  }
}

/** No subject on the request — authentication missing or failed. → 401 */
export class UnauthenticatedError extends RbacError {
  readonly statusCode = 401
  readonly code = 'RBAC_UNAUTHENTICATED'

  constructor(message = 'Unauthorized') {
    super(message)
  }
}

/** Subject lacks the required policy in this portal + context. → 403 */
export class PolicyDeniedError extends RbacError {
  readonly statusCode = 403
  readonly code = 'RBAC_POLICY_DENIED'

  constructor(
    readonly policy: string,
    message = 'Forbidden',
  ) {
    super(message)
  }
}

/** Policy granted but the scope check rejected this resource. → 403 */
export class ScopeDeniedError extends RbacError {
  readonly statusCode = 403
  readonly code = 'RBAC_SCOPE_DENIED'

  constructor(
    readonly policy: string,
    readonly scope: string,
    message = 'Forbidden',
  ) {
    super(message)
  }
}

/** Scoped guard could not resolve the target resource. → 404 */
export class ResourceNotFoundError extends RbacError {
  readonly statusCode = 404
  readonly code = 'RBAC_RESOURCE_NOT_FOUND'

  constructor(message = 'Not found') {
    super(message)
  }
}

/** Library wired incorrectly (developer error, not a request outcome). → 500 */
export class MisconfiguredError extends RbacError {
  readonly statusCode = 500
  readonly code = 'RBAC_MISCONFIGURED'
}
