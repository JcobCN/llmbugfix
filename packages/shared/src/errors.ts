export class AppError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) { super('VALIDATION_ERROR', message, details); this.name = 'ValidationError'; }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) { super('NOT_FOUND', `${resource} not found: ${id}`); this.name = 'NotFoundError'; }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) { super('CONFLICT', message, details); this.name = 'ConflictError'; }
}

export class BoundaryError extends AppError {
  constructor(message: string) { super('PATH_BOUNDARY_VIOLATION', message); this.name = 'BoundaryError'; }
}
