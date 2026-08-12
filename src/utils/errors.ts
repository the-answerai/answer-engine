export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export class AuthenticationError extends AppError {
  constructor(message = 'A valid API key is required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(503, 'PROVIDER_NOT_CONFIGURED', message);
  }
}
