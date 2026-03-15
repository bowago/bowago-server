const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "BowaGO Logistics API",
      version: "1.0.0",
      description: `
## BowaGO — Complete Logistics Platform API

Full backend for the BowaGO Nigerian shipment tracking and logistics platform.

### Authentication
All protected endpoints require a **Bearer token** in the Authorization header.
Get your token from \`POST /auth/login\` or \`POST /auth/google\`.

### Token Lifecycle
- **Access Token** — short-lived (15 min), include in every request
- **Refresh Token** — long-lived (30 days), use \`POST /auth/refresh\` to rotate

### Role Levels
| Role | SubRole | Access |
|------|---------|--------|
| CUSTOMER | — | Own shipments, invoices, profile |
| ADMIN | LOGISTICS_MANAGER | Manage shipments, tracking, support |
| ADMIN | SUPER_ADMIN | Full access including pricing, users, settings |

### Currency
All monetary values are stored in **Kobo** internally. API responses include computed \`amountNaira\` fields for display.
      `,
      contact: {
        name: "BowaGO Support",
        email: "support@bowago.com",
        url: "https://bowago.com",
      },
      license: {
        name: "Proprietary",
      },
    },
    servers: [
      {
        url: "http://localhost:5000/api/v1",
        description: "Local Development",
      },
      {
        url: "https://bowago-backend.vercel.app/api/v1",
        description: "Production",
      },
    ],
    tags: [
      {
        name: "Auth",
        description:
          "Register, login, OAuth, OTP, token refresh, password management",
      },
      {
        name: "Users",
        description: "Profile, addresses, admin user management",
      },
      { name: "Shipments", description: "Create, track, and manage shipments" },
      {
        name: "Pricing",
        description:
          "Quote calculator, cities, box dimensions, price bands, zone matrix",
      },
      {
        name: "Surcharges",
        description:
          "Fuel, VAT, remote area fees, fragile/insurance surcharges, price audit trail",
      },
      {
        name: "Payments",
        description: "Paystack payment init, verification, webhook, refunds",
      },
      {
        name: "Invoices",
        description:
          "My invoices dashboard, PDF download, shipping label, booking confirmation",
      },
      {
        name: "Notifications",
        description: "In-app notifications and FCM push token registration",
      },
      {
        name: "Address Changes",
        description: "Post-booking delivery address change workflow",
      },
      {
        name: "Price Adjustments",
        description: "Weight discrepancy adjustments found at warehouse",
      },
      {
        name: "Claims",
        description: "Insurance claims for damaged, lost, or delayed shipments",
      },
      {
        name: "Support",
        description:
          "Customer support tickets, agent workspace, canned responses",
      },
      {
        name: "FAQ",
        description: "Searchable knowledge base and packaging guidelines",
      },
      {
        name: "Delay Alerts",
        description:
          "Proactive batch delay notifications for multiple customers",
      },
      {
        name: "Admin",
        description: "Dashboard stats, app settings, activity logs",
      },
      {
        name: "Uploads",
        description:
          "Shipment document uploads (waybills, invoices, proof of delivery)",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Paste your access token here. Get one from POST /auth/login",
        },
      },
      schemas: {
        // ─── Generic ──────────────────────────────────────────────────────────

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
            errors: {
              type: "array",
              items: { type: "string" },
              description:
                "Field-level validation errors (only present on 422)",
            },
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

        // ─── Auth & Users ─────────────────────────────────────────────────────

        TokenPair: {
          type: "object",
          properties: {
            accessToken: {
              type: "string",
              description:
                "JWT — expires in 15 minutes. Include in Authorization: Bearer header.",
            },
            refreshToken: {
              type: "string",
              description:
                "JWT — expires in 30 days. Store securely and use to rotate access token.",
            },
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
            phone: {
              type: "string",
              example: "+2348012345678",
              nullable: true,
            },
            firstName: { type: "string", example: "Chidi" },
            lastName: { type: "string", example: "Okafor" },
            avatar: {
              type: "string",
              example:
                "https://res.cloudinary.com/bowago/image/upload/avatars/abc.jpg",
              nullable: true,
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
            fcmToken: {
              type: "string",
              nullable: true,
              description: "Firebase / Expo push token",
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        Address: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            label: { type: "string", example: "Home", nullable: true },
            street: { type: "string", example: "10 Awolowo Road" },
            city: { type: "string", example: "Lagos Cit" },
            state: { type: "string", example: "Lagos" },
            lga: { type: "string", example: "Eti-Osa", nullable: true },
            postalCode: { type: "string", example: "101001", nullable: true },
            isDefault: { type: "boolean" },
            lat: { type: "number", example: 6.4281, nullable: true },
            lng: { type: "number", example: 3.4219, nullable: true },
          },
        },

        // ─── Shipments ────────────────────────────────────────────────────────

        Shipment: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            trackingNumber: { type: "string", example: "BG-20260311-XYZ12" },
            customerId: { type: "string", format: "uuid" },
            assignedToId: { type: "string", format: "uuid", nullable: true },
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
                "PENDING_ADMIN_REVIEW",
              ],
              description:
                "PENDING_ADMIN_REVIEW means an address change request or price adjustment is awaiting admin action",
            },
            senderName: { type: "string", example: "Emeka Obi" },
            senderPhone: { type: "string", example: "08011111111" },
            senderAddress: {
              type: "string",
              example: "10 Awolowo Road, Victoria Island",
            },
            senderCity: { type: "string", example: "Lagos Cit" },
            senderState: { type: "string", example: "Lagos" },
            recipientName: { type: "string", example: "Chidi Nwosu" },
            recipientPhone: { type: "string", example: "08022222222" },
            recipientAddress: { type: "string", example: "5 Ekwulobia Road" },
            recipientCity: { type: "string", example: "Aba" },
            recipientState: { type: "string", example: "Abia" },
            description: { type: "string", nullable: true },
            weight: { type: "number", example: 150 },
            weightUnit: { type: "string", enum: ["KG", "TONS", "CARTONS"] },
            cartons: { type: "integer", example: 5, nullable: true },
            serviceType: {
              type: "string",
              enum: ["EXPRESS", "STANDARD", "ECONOMY"],
              example: "STANDARD",
            },
            zone: { type: "integer", example: 2, nullable: true },
            distanceKm: { type: "number", example: 464, nullable: true },
            quotedPrice: { type: "number", example: 27000 },
            finalPrice: { type: "number", example: 27000, nullable: true },
            currency: { type: "string", example: "NGN" },
            surchargeBreakdown: {
              type: "array",
              nullable: true,
              items: {
                type: "object",
                properties: {
                  type: { type: "string", example: "FUEL" },
                  label: { type: "string", example: "Fuel Surcharge" },
                  description: {
                    type: "string",
                    example: "Adjusted weekly based on market prices",
                    nullable: true,
                  },
                  amount: { type: "number", example: 1485 },
                },
              },
              description:
                "Line-item surcharge breakdown — used in invoice PDFs",
            },
            paymentStatus: {
              type: "string",
              enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
            },
            cutoffWarning: {
              type: "boolean",
              example: false,
              description:
                "true if booked after 2PM WAT — pickup moved to next business day",
            },
            isFragile: { type: "boolean" },
            requiresInsurance: { type: "boolean" },
            insuranceValue: { type: "number", nullable: true },
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
            updatedAt: { type: "string", format: "date-time" },
          },
        },

        TrackingEvent: {
          type: "object",
          properties: {
            status: { type: "string", example: "IN_TRANSIT" },
            location: {
              type: "string",
              example: "Sagamu Interchange Hub",
              nullable: true,
            },
            description: {
              type: "string",
              example: "Package arrived at sorting facility",
            },
            lat: {
              type: "number",
              nullable: true,
              description: "GPS latitude for map tracking",
            },
            lng: {
              type: "number",
              nullable: true,
              description: "GPS longitude for map tracking",
            },
            proofUrl: {
              type: "string",
              nullable: true,
              description: "Cloudinary URL of delivery proof photo",
            },
            updatedBy: {
              type: "string",
              nullable: true,
              description: "User ID of admin who made this update",
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // ─── Pricing ──────────────────────────────────────────────────────────

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
            bestFor: { type: "string", example: "Books/Tools", nullable: true },
            weightKgLimit: { type: "number", example: 10 },
          },
        },

        PriceBand: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            zone: { type: "integer", example: 2 },
            serviceType: {
              type: "string",
              enum: ["EXPRESS", "STANDARD", "ECONOMY"],
              example: "STANDARD",
            },
            minKg: { type: "number", example: 50 },
            maxKg: {
              type: "number",
              example: 200,
              nullable: true,
              description: "null = no upper limit (and above)",
            },
            minTons: { type: "number", example: 0.05 },
            maxTons: { type: "number", nullable: true },
            minCartons: { type: "integer", example: 2 },
            maxCartons: { type: "integer", nullable: true },
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
            surchargeBreakdown: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", example: "FUEL" },
                  label: { type: "string", example: "Fuel Surcharge" },
                  description: { type: "string", nullable: true },
                  amount: { type: "number", example: 1485 },
                },
              },
            },
            totalSurcharge: { type: "number", example: 2700 },
            total: { type: "number", example: 29700 },
            currency: { type: "string", example: "NGN" },
          },
        },

        // ─── Surcharges ───────────────────────────────────────────────────────

        Surcharge: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            type: {
              type: "string",
              enum: [
                "FUEL",
                "REMOTE_AREA",
                "VAT",
                "FRAGILE",
                "INSURANCE",
                "OVERSIZE",
              ],
            },
            label: { type: "string", example: "Fuel Surcharge" },
            description: {
              type: "string",
              example: "Adjusted weekly based on global market prices",
              nullable: true,
            },
            ratePercent: {
              type: "number",
              example: 5.5,
              nullable: true,
              description: "Percentage of base price",
            },
            flatAmount: {
              type: "number",
              nullable: true,
              description: "Fixed NGN amount",
            },
            isActive: { type: "boolean" },
            appliesTo: {
              type: "string",
              example: "ALL",
              description: "ALL | EXPRESS | STANDARD | ECONOMY",
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        PriceAuditLog: {
          type: "object",
          description:
            "Sprint 8 — Full version history of every pricing change",
          properties: {
            id: { type: "string", format: "uuid" },
            entityType: {
              type: "string",
              example: "Surcharge",
              description: "PriceBand | Surcharge | AppSettings",
            },
            entityId: { type: "string" },
            action: { type: "string", enum: ["CREATE", "UPDATE", "DELETE"] },
            previousValue: { type: "object", nullable: true },
            newValue: { type: "object", nullable: true },
            changedBy: { type: "string", format: "uuid" },
            reason: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            user: {
              type: "object",
              properties: {
                id: { type: "string" },
                firstName: { type: "string" },
                lastName: { type: "string" },
                email: { type: "string" },
              },
            },
          },
        },

        // ─── Payments ─────────────────────────────────────────────────────────

        Payment: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            reference: {
              type: "string",
              example: "BWG-A1B2C3D4E5F6G7H8",
              description: "Unique BowaGO payment reference",
            },
            userId: { type: "string", format: "uuid" },
            shipmentId: { type: "string", format: "uuid", nullable: true },
            amountKobo: {
              type: "integer",
              example: 2700000,
              description: "Amount in Kobo — divide by 100 for Naira",
            },
            amountNaira: {
              type: "number",
              example: 27000,
              description: "Computed Naira amount in API responses",
            },
            currency: { type: "string", example: "NGN" },
            status: {
              type: "string",
              enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
            },
            channel: {
              type: "string",
              enum: ["CARD", "BANK_TRANSFER", "USSD", "MOBILE_MONEY", "QR"],
              nullable: true,
            },
            paystackId: { type: "integer", nullable: true },
            gatewayResponse: {
              type: "string",
              example: "Approved",
              nullable: true,
            },
            paidAt: { type: "string", format: "date-time", nullable: true },
            cardLast4: { type: "string", example: "4081", nullable: true },
            cardBank: { type: "string", example: "GTBank", nullable: true },
            refundedAt: { type: "string", format: "date-time", nullable: true },
            refundReference: { type: "string", nullable: true },
            refundAmountKobo: { type: "integer", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // ─── Invoices ─────────────────────────────────────────────────────────

        Invoice: {
          type: "object",
          description: "Sprint 3 — Invoice record derived from a payment",
          properties: {
            invoiceNumber: { type: "string", example: "INV-2603-00123" },
            paymentId: { type: "string", format: "uuid" },
            reference: { type: "string", example: "BWG-A1B2C3D4E5F6G7H8" },
            amount: {
              type: "number",
              example: 27000,
              description: "Amount in Naira",
            },
            currency: { type: "string", example: "NGN" },
            status: {
              type: "string",
              enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
            },
            channel: { type: "string", nullable: true },
            paidAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            shipment: {
              type: "object",
              properties: {
                id: { type: "string" },
                trackingNumber: {
                  type: "string",
                  example: "BG-20260311-XYZ12",
                },
                senderCity: { type: "string" },
                recipientCity: { type: "string" },
                status: { type: "string" },
              },
            },
          },
        },

        // ─── Notifications ────────────────────────────────────────────────────

        Notification: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            type: {
              type: "string",
              enum: [
                "SHIPMENT_UPDATE",
                "PAYMENT",
                "PROMO",
                "SYSTEM",
                "DELAY_ALERT",
                "PRICE_ADJUSTMENT",
              ],
            },
            title: { type: "string", example: "Payment Successful" },
            body: {
              type: "string",
              example: "Your payment of ₦27,000 has been received.",
            },
            data: {
              type: "object",
              nullable: true,
              description: "Extra context e.g. { shipmentId, trackingNumber }",
            },
            isRead: { type: "boolean" },
            readAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // ─── Address Change Requests ──────────────────────────────────────────

        AddressChangeRequest: {
          type: "object",
          description:
            "Sprint 5 — Post-booking delivery address change workflow",
          properties: {
            id: { type: "string", format: "uuid" },
            shipmentId: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            newRecipientAddress: {
              type: "string",
              example: "12 New Layout Road",
            },
            newRecipientCity: { type: "string", example: "Aba" },
            newRecipientState: { type: "string", example: "Abia" },
            reason: { type: "string", nullable: true },
            status: {
              type: "string",
              enum: ["PENDING", "APPROVED", "REJECTED"],
            },
            reviewedBy: { type: "string", nullable: true },
            reviewedAt: { type: "string", format: "date-time", nullable: true },
            reviewNote: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // ─── Price Adjustments ────────────────────────────────────────────────

        PriceAdjustment: {
          type: "object",
          description:
            "Sprint 5/8 — Weight discrepancy found at warehouse. Pauses shipment until customer pays the difference.",
          properties: {
            id: { type: "string", format: "uuid" },
            shipmentId: { type: "string", format: "uuid" },
            originalPrice: { type: "number", example: 27000 },
            adjustedPrice: { type: "number", example: 35000 },
            difference: { type: "number", example: 8000 },
            reason: {
              type: "string",
              example: "Weight discrepancy: quoted 50kg, actual 65kg",
            },
            actualWeightKg: { type: "number", example: 65, nullable: true },
            proofImageUrl: {
              type: "string",
              nullable: true,
              description: "Cloudinary URL of warehouse scale photo",
            },
            isAcknowledged: { type: "boolean", example: false },
            acknowledgedAt: {
              type: "string",
              format: "date-time",
              nullable: true,
            },
            isPaid: { type: "boolean", example: false },
            paymentRef: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // ─── Claims ───────────────────────────────────────────────────────────

        Claim: {
          type: "object",
          description:
            "Sprint 7 — Insurance claim for a damaged, lost, or delayed shipment",
          properties: {
            id: { type: "string", format: "uuid" },
            shipmentId: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            type: { type: "string", enum: ["DAMAGE", "LOSS", "DELAY"] },
            description: {
              type: "string",
              example: "Electronics found cracked upon delivery",
            },
            declaredValue: { type: "number", example: 250000 },
            claimAmount: { type: "number", example: 200000 },
            bankName: { type: "string", example: "GTBank", nullable: true },
            accountNumber: {
              type: "string",
              example: "0123456789",
              nullable: true,
            },
            accountName: {
              type: "string",
              example: "Chidi Okafor",
              nullable: true,
            },
            status: {
              type: "string",
              enum: [
                "SUBMITTED",
                "UNDER_REVIEW",
                "APPROVED",
                "REJECTED",
                "PAID",
              ],
            },
            reviewNote: { type: "string", nullable: true },
            approvedAmount: { type: "number", nullable: true },
            paidAt: { type: "string", format: "date-time", nullable: true },
            images: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  url: {
                    type: "string",
                    description: "Cloudinary URL of damage photo",
                  },
                },
              },
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // ─── Support Tickets ──────────────────────────────────────────────────

        SupportTicket: {
          type: "object",
          description:
            "Sprint 6 — Customer support ticket with auto-assignment and message threading",
          properties: {
            id: { type: "string", format: "uuid" },
            ticketNumber: { type: "string", example: "TKT-20260311-AB12" },
            customerId: { type: "string", format: "uuid" },
            assignedToId: { type: "string", format: "uuid", nullable: true },
            category: {
              type: "string",
              enum: [
                "TRACKING",
                "PAYMENT",
                "PRICING_DISPUTE",
                "DAMAGED_GOODS",
                "DELIVERY_ISSUE",
                "ACCOUNT",
                "OTHER",
              ],
            },
            subject: {
              type: "string",
              example: "Package not received after 7 days",
            },
            status: {
              type: "string",
              enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "ESCALATED"],
            },
            priority: {
              type: "string",
              enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
              example: "NORMAL",
            },
            shipmentId: { type: "string", format: "uuid", nullable: true },
            resolvedAt: { type: "string", format: "date-time", nullable: true },
            closedAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },

        TicketMessage: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            ticketId: { type: "string", format: "uuid" },
            senderId: { type: "string", format: "uuid" },
            body: { type: "string" },
            isInternal: {
              type: "boolean",
              description: "true = agent-only note, hidden from customer",
            },
            attachmentUrl: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        CannedResponse: {
          type: "object",
          description:
            "Sprint 6 — Pre-approved response template for support agents",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string", example: "Customs Delay Explanation" },
            body: {
              type: "string",
              example:
                "Dear Customer, your shipment is currently held at customs...",
            },
            category: { type: "string", example: "Customs", nullable: true },
            isActive: { type: "boolean" },
          },
        },

        // ─── FAQ ──────────────────────────────────────────────────────────────

        FaqItem: {
          type: "object",
          description: "Sprint 5 — Searchable knowledge base item",
          properties: {
            id: { type: "string", format: "uuid" },
            question: {
              type: "string",
              example: "How is my shipping cost calculated?",
            },
            answer: {
              type: "string",
              example:
                "Your cost is based on the zone between origin and destination...",
            },
            category: {
              type: "string",
              enum: [
                "PRICING",
                "SHIPPING_RULES",
                "TRACKING",
                "PAYMENTS",
                "ACCOUNT",
                "PACKAGING",
                "CLAIMS",
              ],
            },
            sortOrder: { type: "integer", example: 0 },
            isActive: { type: "boolean" },
          },
        },

        // ─── App Settings ─────────────────────────────────────────────────────

        AppSetting: {
          type: "object",
          properties: {
            key: { type: "string", example: "fragile_surcharge_percent" },
            value: { type: "string", example: "10" },
            type: {
              type: "string",
              enum: ["string", "number", "boolean", "json"],
            },
            group: { type: "string", example: "pricing", nullable: true },
          },
        },
      }, // end schemas
    }, // end components
    security: [{ bearerAuth: [] }],
  },
  apis: [require("path").join(__dirname, "../routes/*.js")],
};

module.exports = swaggerJsdoc(options);
