const { v2: cloudinary } = require('cloudinary');
const config = require('../config');
const { AppError } = require('../middleware/error');

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
});

const uploadToCloudinary = (fileBuffer, folder = 'ecommerce_products') => {
  if (!config.cloudinary.cloudName || !config.cloudinary.apiKey || !config.cloudinary.apiSecret) {
    throw new AppError('Cloudinary credentials are not configured in .env', 500);
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'auto', // Automatically handles both images and videos
      },
      (error, result) => {
        if (error) return reject(new AppError(`Cloudinary upload failed: ${error.message}`, 500));
        resolve(result);
      }
    );
    stream.end(fileBuffer);
  });
};

module.exports = { uploadToCloudinary };