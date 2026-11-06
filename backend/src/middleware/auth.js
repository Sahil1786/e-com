const jwt = require('jsonwebtoken');
const config = require('../config');
const prisma = require('../prisma');
const { AppError } = require('./error');

const authenticate = async (req, res, next) => {
  const authorization = req.headers.authorization;
  const token = req.cookies?.token ||
    (authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null);
  if (!token) return next(new AppError('Authentication required', 401));

  let payload;
  try {
    if (!config.jwtSecret) throw new Error('JWT_SECRET is not configured');
    const verified = jwt.verify(token, config.jwtSecret);
    if (!verified || typeof verified === 'string' || typeof verified.id !== 'string') {
      throw new Error('Invalid token payload');
    }
    payload = verified;
  } catch (err) {
    return next(new AppError('Invalid or expired token', 401));
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) return next(new AppError('User no longer exists', 401));
    if (typeof payload.exp !== 'number') {
      return next(new AppError('Invalid or expired token', 401));
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
    };
    req.authExpiresAt = payload.exp ? payload.exp * 1000 : null;
    return next();
  } catch (err) {
    return next(err);
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'ADMIN') {
    return next(new AppError('Admin access required', 403));
  }
  next();
};

const requireCustomer = (req, res, next) => {
  if (
    req.user?.role === 'ADMIN' &&
    req.method === 'GET' &&
    /^\/orders\/[^/]+\/invoice$/.test(req.path)
  ) {
    return next();
  }
  if (req.user?.role !== 'CUSTOMER') {
    return next(new AppError('Customer access required', 403));
  }
  next();
};

module.exports = { authenticate, requireAdmin, requireCustomer };