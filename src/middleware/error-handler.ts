import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} was not found`, statusCode: 404 },
  });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', statusCode: 400, details: error.issues },
    });
    return;
  }
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message, statusCode: error.statusCode, details: error.details },
    });
    return;
  }
  const databaseCode = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
  if (databaseCode === '23505' || databaseCode === '23503' || databaseCode === '23514') {
    res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'The request conflicts with an existing resource or data constraint',
        statusCode: 409,
      },
    });
    return;
  }
  logger.error('Unhandled request error', {
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', statusCode: 500 },
  });
};
