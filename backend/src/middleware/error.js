class AppError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  
  const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.statusCode || 500;
    const requestPath = req.originalUrl?.split("?")[0] || req.path;
    const message = err.message || "Internal Server Error";
    if (status >= 500) {
      console.error(`[API ${status}] ${req.method} ${requestPath}:`, err);
    } else {
      console.warn(`[API ${status}] ${req.method} ${requestPath}: ${message}`);
    }
    res.status(status).json({
      success: false,
      error:
        status >= 500 && process.env.NODE_ENV === 'production'
          ? 'Internal Server Error'
          : message,
    });
  };
  
  module.exports = { AppError, errorHandler };