const router = require('express').Router();
const { uploadDocument, deleteFromCloudinary } = require('../config/cloudinary');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');
const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success } = require('../utils/helpers');

/**
 * @swagger
 * tags:
 *   name: Uploads
 *   description: Shipment document uploads (waybills, invoices, proof of delivery). Admin only.
 */

router.use(authenticate);

/**
 * @swagger
 * /uploads/shipments/{shipmentId}/documents:
 *   post:
 *     summary: Upload a document to a shipment (Admin)
 *     tags: [Uploads]
 *     description: >
 *       Uploads a file (image or PDF) to Cloudinary and attaches it to the specified shipment.
 *       Accepted document types: WAYBILL, INVOICE, PROOF_OF_DELIVERY, OTHER.
 *       Max file size: 20MB. Accepted formats: JPG, JPEG, PNG, PDF.
 *     parameters:
 *       - in: path
 *         name: shipmentId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: The ID of the shipment to attach the document to
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Document file (JPG, PNG, PDF — max 20MB)
 *               type:
 *                 type: string
 *                 enum: [WAYBILL, INVOICE, PROOF_OF_DELIVERY, OTHER]
 *                 default: OTHER
 *                 description: Document type
 *     responses:
 *       201:
 *         description: Document uploaded and attached to shipment
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     document:
 *                       type: object
 *                       properties:
 *                         id: { type: string, format: uuid }
 *                         shipmentId: { type: string, format: uuid }
 *                         type: { type: string, example: PROOF_OF_DELIVERY }
 *                         url: { type: string, example: "https://res.cloudinary.com/bowago/image/upload/shipments/abc.jpg" }
 *                         publicId: { type: string }
 *                         createdAt: { type: string, format: date-time }
 *       400:
 *         description: No file uploaded
 *       404:
 *         description: Shipment not found
 *       403:
 *         description: Admin access required
 */
router.post(
  '/shipments/:shipmentId/documents',
  requireLogisticsOrAbove,
  uploadDocument.single('file'),
  async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded');

    const { shipmentId } = req.params;
    const { type } = req.body;

    const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new ApiError(404, 'Shipment not found');

    const doc = await prisma.shipmentDocument.create({
      data: {
        shipmentId,
        type: type || 'OTHER',
        url: req.file.path,
        publicId: req.file.filename,
        uploadedBy: req.user.id,
      },
    });

    return success(res, { document: doc }, 'Document uploaded', 201);
  }
);

/**
 * @swagger
 * /uploads/documents/{id}:
 *   delete:
 *     summary: Delete a shipment document (Admin)
 *     tags: [Uploads]
 *     description: Deletes the document record from the database and removes the file from Cloudinary.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Document ID
 *     responses:
 *       200:
 *         description: Document deleted from database and Cloudinary
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Document not found
 *       403:
 *         description: Admin access required
 */
router.delete('/documents/:id', requireLogisticsOrAbove, async (req, res) => {
  const { id } = req.params;

  const doc = await prisma.shipmentDocument.findUnique({ where: { id } });
  if (!doc) throw new ApiError(404, 'Document not found');

  await deleteFromCloudinary(doc.publicId, doc.url.includes('.pdf') ? 'raw' : 'image');
  await prisma.shipmentDocument.delete({ where: { id } });

  return success(res, {}, 'Document deleted');
});

module.exports = router;
