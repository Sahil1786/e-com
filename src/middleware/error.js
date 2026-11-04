class AppError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  
  const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
      success: false,
      error:
        status >= 500 && process.env.NODE_ENV === 'production'
          ? 'Internal Server Error'
          : err.message || 'Internal Server Error',
    });
  };
  
  module.exports = { AppError, errorHandler };