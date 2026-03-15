const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "BowaGO Logistics API",
      version: "1.0.0",
      description:
        "Complete backend API for the BowaGO shipment tracking and logistics platform.",
    },
    servers: [
      { url: "http://localhost:5000/api/v1", description: "Local Development" },
      {
        url: "https://bowago-backend.vercel.app/api/v1",
        description: "Production",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your access token. Get one from POST /auth/login",
        },
      },
      schemas: {
        SuccessResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: { type: "string", example: "Success" },
            data: { type: "object" },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            message: { type: "string", example: "An error occurred" },
            errors: { type: "array", items: { type: "string" } },
          },
        },
        PaginationMeta: {
          type: "object",
          properties: {
            total: { type: "integer", example: 100 },
            page: { type: "integer", example: 1 },
            limit: { type: "integer", example: 20 },
            totalPages: { type: "integer", example: 5 },
            hasNext: { type: "boolean", example: true },
            hasPrev: { type: "boolean", example: false },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            email: {
              type: "string",
              format: "email",
              example: "chidi@example.com",
            },
            phone: { type: "string", example: "+2348012345678" },
            firstName: { type: "string", example: "Chidi" },
            lastName: { type: "string", example: "Okafor" },
            avatar: {
              type: "string",
              example:
                "https://res.cloudinary.com/bowago/image/upload/avatars/abc.jpg",
            },
            role: { type: "string", enum: ["CUSTOMER", "ADMIN"] },
            adminSubRole: {
              type: "string",
              enum: ["LOGISTICS_MANAGER", "SUPER_ADMIN"],
              nullable: true,
            },
            authProvider: {
              type: "string",
              enum: ["EMAIL", "GOOGLE", "APPLE"],
            },
            isEmailVerified: { type: "boolean" },
            isPhoneVerified: { type: "boolean" },
            isActive: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Address: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            label: { type: "string", example: "Home" },
            street: { type: "string", example: "10 Awolowo Road" },
            city: { type: "string", example: "Lagos Cit" },
            state: { type: "string", example: "Lagos" },
            lga: { type: "string", example: "Eti-Osa" },
            postalCode: { type: "string", example: "101001" },
            isDefault: { type: "boolean" },
            lat: { type: "number", example: 6.4281 },
            lng: { type: "number", example: 3.4219 },
          },
        },
        TokenPair: {
          type: "object",
          properties: {
            accessToken: {
              type: "string",
              description: "JWT access token, expires in 15 minutes",
            },
            refreshToken: {
              type: "string",
              description: "JWT refresh token, expires in 30 days",
            },
          },
        },
        Shipment: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            trackingNumber: { type: "string", example: "BG-20260311-XYZ12" },
            status: {
              type: "string",
              enum: [
                "PENDING",
                "CONFIRMED",
                "PICKED_UP",
                "IN_TRANSIT",
                "OUT_FOR_DELIVERY",
                "DELIVERED",
                "FAILED",
                "CANCELLED",
                "RETURNED",
              ],
            },
            senderName: { type: "string", example: "Emeka Obi" },
            senderPhone: { type: "string", example: "08011111111" },
            senderAddress: { type: "string", example: "10 Awolowo Road" },
            senderCity: { type: "string", example: "Lagos Cit" },
            senderState: { type: "string", example: "Lagos" },
            recipientName: { type: "string", example: "Chidi Nwosu" },
            recipientPhone: { type: "string", example: "08022222222" },
            recipientAddress: { type: "string", example: "5 Ekwulobia Road" },
            recipientCity: { type: "string", example: "Aba" },
            recipientState: { type: "string", example: "Abia" },
            description: {
              type: "string",
              example: "Electronics and accessories",
            },
            weight: { type: "number", example: 150 },
            weightUnit: { type: "string", enum: ["KG", "TONS", "CARTONS"] },
            cartons: { type: "integer", example: 5 },
            zone: { type: "integer", example: 2 },
            distanceKm: { type: "number", example: 464 },
            quotedPrice: { type: "number", example: 27000 },
            finalPrice: { type: "number", example: 27000, nullable: true },
            currency: { type: "string", example: "NGN" },
            paymentStatus: {
              type: "string",
              enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
            },
            isFragile: { type: "boolean" },
            requiresInsurance: { type: "boolean" },
            insuranceValue: { type: "number", example: 500000, nullable: true },
            pickupDate: { type: "string", format: "date-time", nullable: true },
            estimatedDelivery: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
            deliveredAt: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
            notes: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        TrackingEvent: {
          type: "object",
          properties: {
            status: { type: "string" },
            location: { type: "string", example: "Sagamu Interchange Hub" },
            description: {
              type: "string",
              example: "Package arrived at sorting facility",
            },
            lat: { type: "number", nullable: true },
            lng: { type: "number", nullable: true },
            proofUrl: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        City: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string", example: "Lagos Cit" },
            region: { type: "string", example: "South West" },
            state: { type: "string", example: "Lagos" },
          },
        },
        BoxDimension: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            categoryId: { type: "string", example: "S-01" },
            displayName: { type: "string", example: "Small Shipping Box (S)" },
            lengthCm: { type: "number", example: 30 },
            widthCm: { type: "number", example: 22 },
            heightCm: { type: "number", example: 22 },
            bestFor: { type: "string", example: "Books/Tools" },
            weightKgLimit: { type: "number", example: 10 },
          },
        },
        PriceBand: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            zone: { type: "integer", example: 2 },
            minKg: { type: "number", example: 50 },
            maxKg: { type: "number", example: 200, nullable: true },
            minTons: { type: "number", example: 0.05 },
            maxTons: { type: "number", example: 0.2, nullable: true },
            minCartons: { type: "integer", example: 2 },
            maxCartons: { type: "integer", example: 6, nullable: true },
            pricePerKg: { type: "number", example: 180, nullable: true },
            basePrice: { type: "number", example: 9000, nullable: true },
            isActive: { type: "boolean" },
          },
        },
        ShippingQuote: {
          type: "object",
          properties: {
            zone: { type: "integer", example: 2 },
            distanceKm: { type: "number", example: 464, nullable: true },
            weightKg: { type: "number", example: 150 },
            fromCity: { $ref: "#/components/schemas/City" },
            toCity: { $ref: "#/components/schemas/City" },
            breakdown: {
              type: "object",
              properties: {
                priceBandId: { type: "string" },
                pricePerKg: { type: "number", example: 180, nullable: true },
                basePrice: { type: "number", nullable: true },
                subtotal: { type: "number", example: 27000 },
              },
            },
            total: { type: "number", example: 27000 },
            currency: { type: "string", example: "NGN" },
          },
        },
        Notification: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            type: {
              type: "string",
              enum: ["SHIPMENT_UPDATE", "PAYMENT", "PROMO", "SYSTEM"],
            },
            title: { type: "string", example: "Shipment BG-20260311-XYZ12" },
            body: {
              type: "string",
              example: "Your shipment is now in transit",
            },
            data: { type: "object", nullable: true },
            isRead: { type: "boolean" },
            readAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ["./src/routes/*.js"],
};

module.exports = swaggerJsdoc(options);
