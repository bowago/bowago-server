const router = require("express").Router();
const userController = require("../controllers/user.controller");
const {
  authenticate,
  requireAdmin,
  requireSuperAdmin,
} = require("../middleware/auth");
const { uploadAvatar } = require("../config/cloudinary");

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: Profile management, addresses, and admin user operations
 */

/**
 * @swagger
 * /users/me:
 *   get:
 *     summary: Get my profile
 *     tags: [Users]
 *     description: Returns the full profile of the currently authenticated user, including all saved addresses.
 *     responses:
 *       200:
 *         description: Profile retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       allOf:
 *                         - $ref: '#/components/schemas/User'
 *                         - type: object
 *                           properties:
 *                             addresses:
 *                               type: array
 *                               items:
 *                                 $ref: '#/components/schemas/Address'
 *       401:
 *         description: Unauthorized
 */
router.get("/me", authenticate, userController.getProfile);

/**
 * @swagger
 * /users/me:
 *   patch:
 *     summary: Update my profile
 *     tags: [Users]
 *     description: Update first name, last name, or phone number.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName: { type: string, example: Chidi }
 *               lastName: { type: string, example: Okafor }
 *               phone: { type: string, example: "+2348012345678" }
 *     responses:
 *       200:
 *         description: Profile updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       409:
 *         description: Phone number already in use by another account
 *       401:
 *         description: Unauthorized
 */
router.patch("/me", authenticate, userController.updateProfile);

/**
 * @swagger
 * /users/me/company:
 *   patch:
 *     summary: Update the authenticated user's company information
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               companyName:    { type: string }
 *               industry:       { type: string }
 *               companyEmail:   { type: string, format: email }
 *               companyPhone:   { type: string }
 *               companyWebsite: { type: string }
 *               streetAddress:  { type: string }
 *               city:           { type: string }
 *               state:          { type: string }
 *               country:        { type: string }
 *               zipCode:        { type: string }
 *     responses:
 *       200:
 *         description: Company information updated
 */
router.patch("/me/company", authenticate, userController.updateCompanyInfo);

// DELETE /users/me — customer deletes their own account (requires password)
router.delete("/me", authenticate, userController.deleteOwnAccount);



/**
 * @swagger
 * /users/me/saved-cards:
 *   get:
 *     summary: List the authenticated user's saved cards (Paystack reusable authorizations)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of saved cards
 */
router.get("/me/saved-cards", authenticate, userController.listSavedCards);

/**
 * @swagger
 * /users/me/saved-cards/{id}/default:
 *   patch:
 *     summary: Set a saved card as the default
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Default card updated
 *       404:
 *         description: Saved card not found
 */
router.patch("/me/saved-cards/:id/default", authenticate, userController.setDefaultCard);

/**
 * @swagger
 * /users/me/saved-cards/{id}:
 *   delete:
 *     summary: Remove a saved card
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Card removed
 *       404:
 *         description: Saved card not found
 */
router.delete("/me/saved-cards/:id", authenticate, userController.deleteSavedCard);


/**
 * @swagger
 * /users/me/avatar:
 *   post:
 *     summary: Upload profile photo
 *     tags: [Users]
 *     description: Upload a profile picture. Accepts JPG, PNG, WEBP. Max 5MB. The image is auto-cropped to 400x400 face-fill via Cloudinary.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [avatar]
 *             properties:
 *               avatar:
 *                 type: string
 *                 format: binary
 *                 description: Image file (JPG, PNG, WEBP — max 5MB)
 *     responses:
 *       200:
 *         description: Avatar uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     avatar: { type: string, example: "https://res.cloudinary.com/bowago/image/upload/avatars/abc.jpg" }
 *       400:
 *         description: No image uploaded
 *       401:
 *         description: Unauthorized
 */
router.post(
  "/me/avatar",
  authenticate,
  uploadAvatar.single("avatar"),
  userController.uploadAvatar,
);

/**
 * @swagger
 * /users/me/addresses:
 *   post:
 *     summary: Add a new address
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [street, city, state]
 *             properties:
 *               label: { type: string, example: Home }
 *               street: { type: string, example: "10 Awolowo Road" }
 *               city: { type: string, example: "Lagos Cit" }
 *               state: { type: string, example: Lagos }
 *               lga: { type: string, example: "Eti-Osa" }
 *               postalCode: { type: string, example: "101001" }
 *               isDefault: { type: boolean, example: true }
 *               lat: { type: number, example: 6.4281 }
 *               lng: { type: number, example: 3.4219 }
 *     responses:
 *       201:
 *         description: Address added
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     address:
 *                       $ref: '#/components/schemas/Address'
 *       401:
 *         description: Unauthorized
 */
router.post("/me/addresses", authenticate, userController.addAddress);

/**
 * @swagger
 * /users/me/addresses/{id}:
 *   put:
 *     summary: Update an address
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Address ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label: { type: string }
 *               street: { type: string }
 *               city: { type: string }
 *               state: { type: string }
 *               lga: { type: string }
 *               postalCode: { type: string }
 *               isDefault: { type: boolean }
 *               lat: { type: number }
 *               lng: { type: number }
 *     responses:
 *       200:
 *         description: Address updated
 *       404:
 *         description: Address not found
 *       401:
 *         description: Unauthorized
 */
router.put("/me/addresses/:id", authenticate, userController.updateAddress);

/**
 * @swagger
 * /users/me/addresses/{id}:
 *   delete:
 *     summary: Delete an address
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Address ID
 *     responses:
 *       200:
 *         description: Address deleted
 *       404:
 *         description: Address not found
 *       401:
 *         description: Unauthorized
 */
router.delete("/me/addresses/:id", authenticate, userController.deleteAddress);

/**
 * @swagger
 * /users:
 *   get:
 *     summary: List all users (Admin)
 *     tags: [Users]
 *     description: Paginated list of all users. Supports filtering by role, status, and search.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [CUSTOMER, ADMIN] }
 *       - in: query
 *         name: isActive
 *         schema: { type: boolean }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by email, name, or phone
 *     responses:
 *       200:
 *         description: Users list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     users:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/User'
 *                 meta:
 *                   $ref: '#/components/schemas/PaginationMeta'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.get("/", authenticate, requireAdmin, userController.listUsers);

/**
 * @swagger
 * /users/{id}/status:
 *   patch:
 *     summary: Activate or suspend a user (Admin)
 *     tags: [Users]
 *     description: Toggles the isActive flag for the user. Suspended users cannot log in.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: User ID
 *     responses:
 *       200:
 *         description: User status toggled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *                       properties:
 *                         id: { type: string }
 *                         email: { type: string }
 *                         isActive: { type: boolean }
 *       404:
 *         description: User not found
 *       403:
 *         description: Admin access required
 */
router.patch(
  "/:id/status",
  authenticate,
  requireAdmin,
  userController.toggleUserStatus,
);

/**
 * @swagger
 * /users/{id}/role:
 *   patch:
 *     summary: Set admin role (Super Admin only)
 *     tags: [Users]
 *     description: Promotes a user to admin or updates their admin sub-role. Only callable by SUPER_ADMIN.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               adminSubRole:
 *                 type: string
 *                 enum: [SUPER_ADMIN, LOGISTICS_MANAGER, ROLE_ADMIN, CUSTOMER]
 *                 description: >
 *                   Internal BowaGo staff sub-role only. Pass "CUSTOMER" (or set
 *                   role:"CUSTOMER") to revoke admin access and revert to a regular
 *                   customer. This endpoint can NEVER assign an Enterprise role
 *                   (ROLE_MASTER, ROLE_AGENT, ROLE_DISPATCHER, ROLE_FINANCE, ROLE_USER)
 *                   — those are managed via /organization/invite-member instead.
 *                 example: LOGISTICS_MANAGER
 *               role:
 *                 type: string
 *                 enum: [ADMIN, CUSTOMER]
 *                 description: Optional. Set to "CUSTOMER" to demote an admin back to a regular customer.
 *     responses:
 *       200:
 *         description: Admin role updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       403:
 *         description: Super admin access required
 *       404:
 *         description: User not found
 */
router.patch(
  "/:id/role",
  authenticate,
  requireSuperAdmin,
  userController.setAdminRole,
);

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get user by ID (Admin)
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User detail with shipment history
 *       404:
 *         description: User not found
 */
router.get("/:id", authenticate, requireAdmin, userController.getUserById);

/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Delete user (Super Admin only)
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User deleted
 *       400:
 *         description: Cannot delete own account
 *       403:
 *         description: Cannot delete another Super Admin
 *       404:
 *         description: User not found
 */
router.delete(
  "/:id",
  authenticate,
  requireSuperAdmin,
  userController.deleteUser,
);

module.exports = router;
