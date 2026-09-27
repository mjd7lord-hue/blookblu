export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, code, msg, details);
export const unauthorized = (msg = 'ابتدا وارد حساب شوید', code = 'UNAUTHORIZED') => new AppError(401, code, msg);
export const forbidden = (msg = 'اجازهٔ این کار را ندارید', code = 'FORBIDDEN') => new AppError(403, code, msg);
export const notFound = (msg = 'پیدا نشد', code = 'NOT_FOUND') => new AppError(404, code, msg);
export const conflict = (msg: string, code = 'CONFLICT') => new AppError(409, code, msg);
export const tooMany = (msg: string, code = 'TOO_MANY_REQUESTS', details?: unknown) =>
  new AppError(429, code, msg, details);
