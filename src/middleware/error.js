class AppError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  
  const errorHandler = (err, req, res, next) => {
    const status = err.statusCode || 500;
    res.status(status).json({
      success: false,
      error: err.message || 'Internal Server Error',
    });
  };
  
  module.exports = { AppError, errorHandler };