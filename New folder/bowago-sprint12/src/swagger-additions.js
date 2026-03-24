// ─── ADD THESE SCHEMAS into the components.schemas block of src/config/swagger.js ──
// Paste them after the existing AppSetting schema entry

ContractRate: {
  type: 'object',
  description: 'Sprint 2 — B2B enterprise rate card. Overrides standard pricing for an enterprise client.',
  properties: {
    id:           { type: 'string', format: 'uuid' },
    userId:       { type: 'string', format: 'uuid' },
    label:        { type: 'string', example: 'Dangote Group — Annual Contract', nullable: true },
    serviceType:  { type: 'string', enum: ['EXPRESS', 'STANDARD', 'ECONOMY'], nullable: true, description: 'null = applies to all service types' },
    discountPercent: { type: 'number', example: 15, nullable: true, description: 'Percentage off standard rate' },
    fixedPricePerKgByZone: {
      type: 'object',
      nullable: true,
      example: { '1': 150, '2': 120, '3': 100, '4': 90 },
      description: 'Fixed NGN/kg price per zone. Overrides price band entirely.',
    },
    isActive:    { type: 'boolean' },
    validFrom:   { type: 'string', format: 'date-time', nullable: true },
    validUntil:  { type: 'string', format: 'date-time', nullable: true, description: 'null = no expiry' },
    notes:       { type: 'string', nullable: true },
    createdAt:   { type: 'string', format: 'date-time' },
    user: {
      type: 'object',
      properties: {
        id:        { type: 'string' },
        firstName: { type: 'string' },
        lastName:  { type: 'string' },
        email:     { type: 'string' },
      },
    },
  },
},

PromoCode: {
  type: 'object',
  description: 'Sprint 2 — Promotional discount code. Applied when user has no contract rate.',
  properties: {
    id:              { type: 'string', format: 'uuid' },
    code:            { type: 'string', example: 'WELCOME20' },
    description:     { type: 'string', nullable: true },
    discountPercent: { type: 'number', example: 20, nullable: true },
    flatDiscount:    { type: 'number', example: 5000, nullable: true },
    minOrderAmount:  { type: 'number', example: 10000, nullable: true },
    maxUses:         { type: 'integer', nullable: true, description: 'null = unlimited' },
    usedCount:       { type: 'integer', example: 47 },
    isActive:        { type: 'boolean' },
    validFrom:       { type: 'string', format: 'date-time', nullable: true },
    validUntil:      { type: 'string', format: 'date-time', nullable: true },
    serviceType:     { type: 'string', enum: ['EXPRESS', 'STANDARD', 'ECONOMY'], nullable: true },
    createdAt:       { type: 'string', format: 'date-time' },
  },
},

PolicyContent: {
  type: 'object',
  description: 'Sprint 2 Story 9.4 — Legal policy content (T&C, Refund Policy, Pricing Policy). Shown at quote and payment screens.',
  properties: {
    id:        { type: 'string', format: 'uuid' },
    key:       { type: 'string', example: 'terms_of_service', description: 'terms_of_service | refund_policy | pricing_policy | liability | privacy_policy' },
    title:     { type: 'string', example: 'Terms of Service' },
    body:      { type: 'string', description: 'Markdown or HTML content rendered on the frontend' },
    isActive:  { type: 'boolean' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
},

PackagingGuide: {
  type: 'object',
  description: 'Sprint 5 Story 11.5 — Packaging instructions and dangerous goods rules. Accessible within 2 clicks from booking confirmation.',
  properties: {
    id:          { type: 'string', format: 'uuid' },
    title:       { type: 'string', example: 'How to Pack Fragile Items' },
    body:        { type: 'string', description: 'Markdown content with packaging instructions' },
    category:    { type: 'string', enum: ['GENERAL', 'FRAGILE', 'DANGEROUS_GOODS', 'ELECTRONICS', 'CLOTHING'] },
    imageUrl:    { type: 'string', nullable: true, description: 'Cloudinary URL for illustration' },
    sortOrder:   { type: 'integer', example: 0 },
    isDangerous: { type: 'boolean', description: 'true = this is a dangerous goods rule — shown prominently' },
    isActive:    { type: 'boolean' },
    createdAt:   { type: 'string', format: 'date-time' },
  },
},

// ─── ALSO ADD these to the tags array in swagger options.definition ────────────
// { name: 'Contract Rates', description: 'Sprint 2 — B2B enterprise rate cards' },
// { name: 'Promo Codes',    description: 'Sprint 2 — Promotional discount codes' },
// { name: 'Policies & Guides', description: 'Sprint 2 Story 9.4 + Sprint 5 Story 11.5 — T&C, policies, packaging guide' },
