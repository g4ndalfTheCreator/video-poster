export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg);
export const unauthorized = (msg = 'authentication required') => new HttpError(401, 'unauthorized', msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const tooMany = (msg = 'too many requests') => new HttpError(429, 'rate_limited', msg);
