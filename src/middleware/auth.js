const jwt = require('jsonwebtoken');
const config = require('../config');
const prisma = require('../prisma');
const { AppError } = require('./error');

const authenticate = async (req, res, next) => {
  try {
    const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
    if (!token) throw new AppError('Authentication required', 401);

    const decoded = jwt.verify(token, config.jwtSecret);
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) throw new AppError('User no longer exists', 401);

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
    };
    next();
  } catch (err) {
    next(new AppError('Invalid or expired token', 401));
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'ADMIN') {
    return next(new AppError('Admin access required', 403));
  }
  next();
};

module.exports = { authenticate, requireAdmin };