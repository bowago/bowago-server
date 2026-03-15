const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Storage Configurations ───────────────────────────────────────────────────

const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'bowago/avatars',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
  },
});

const documentStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder: `bowago/shipments/${req.params.shipmentId || 'general'}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
    resource_type: 'auto',
  }),
});

const importStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'bowago/imports',
    allowed_formats: ['xlsx', 'csv'],
    resource_type: 'raw',
  },
});

// ─── Multer Upload Instances ──────────────────────────────────────────────────

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const uploadDocument = multer({
  storage: documentStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

const uploadImport = multer({
  storage: multer.memoryStorage(), // use memory for Excel processing
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'text/csv'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel and CSV files are allowed'), false);
    }
  },
});

// ─── Helper: Delete from Cloudinary ──────────────────────────────────────────

async function deleteFromCloudinary(publicId, resourceType = 'image') {
  try {
    return await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('Cloudinary delete error:', err);
  }
}

module.exports = {
  cloudinary,
  uploadAvatar,
  uploadDocument,
  uploadImport,
  deleteFromCloudinary,
};
