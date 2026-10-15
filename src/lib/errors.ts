/**
 * Typed application errors. HTTP mapping lives in src/server/http; messages
 * are safe to return to clients and must never contain secrets.
 */
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends AppError {
  readonly status = 401;
  readonly code = "unauthenticated";
  constructor(message = "Authentication required") {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code = "forbidden";
  constructor(message = "You do not have permission to perform this action") {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = "not_found";
}

export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = "validation_failed";
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

export class ConflictError extends AppError {
  readonly status = 409;
  readonly code = "conflict";
}

/** A request is well-formed but violates a Tracklibute policy (e.g. approval required). */
export class PolicyViolationError extends AppError {
  readonly status = 422;
  readonly code = "policy_violation";
}
