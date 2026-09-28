import "server-only";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Non authentifié") {
    super(message, "UNAUTHORIZED", 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Accès refusé") {
    super(message, "FORBIDDEN", 403);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Ressource") {
    super(`${what} introuvable`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly issues: unknown = null,
  ) {
    super(message, "VALIDATION", 422);
    this.name = "ValidationError";
  }
}

export class NotConfiguredError extends AppError {
  constructor(what: string) {
    super(`${what} n'est pas configuré`, "NOT_CONFIGURED", 501);
    this.name = "NotConfiguredError";
  }
}
