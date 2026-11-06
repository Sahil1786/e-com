const multer = require('multer');
const { AppError } = require('./error');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedMime = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/;
  if (allowedMime.test(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        'Only images (JPEG, PNG, WEBP, GIF) and videos (MP4, WEBM, MOV) are allowed',
        400
      )
    );
  }
};

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
});