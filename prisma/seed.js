const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

// ─── Seed Data from Excel ──────────────────────────────────────────────────────

const cities = [
  // South East
  { name: "Aba", region: "South East", state: "Abia" },
  { name: "Abakaliki", region: "South East", state: "Ebonyi" },
  { name: "Awka", region: "South East", state: "Anambra" },
  { name: "Enugu", region: "South East", state: "Enugu" },
  { name: "Owerri", region: "South East", state: "Imo" },
  { name: "Umuahia", region: "South East", state: "Abia" },
  // South South
  { name: "Asaba", region: "South South", state: "Delta" },
  { name: "Benin Cit", region: "South South", state: "Edo" },
  { name: "Calabar", region: "South South", state: "Cross River" },
  { name: "Port Harc", region: "South South", state: "Rivers" },
  { name: "Uyo", region: "South South", state: "Akwa Ibom" },
  { name: "Yenegoa", region: "South South", state: "Bayelsa" },
  // North Central
  { name: "Abuja", region: "North Central", state: "FCT" },
  { name: "Jos", region: "North Central", state: "Plateau" },
  { name: "Lafia", region: "North Central", state: "Nasarawa" },
  { name: "Lokoja", region: "North Central", state: "Kogi" },
  { name: "Makurdi", region: "North Central", state: "Benue" },
  { name: "Minna", region: "North Central", state: "Niger" },
  { name: "Ilorin", region: "North Central", state: "Kwara" },
  // North East
  { name: "Bauchi", region: "North East", state: "Bauchi" },
  { name: "Damatur", region: "North East", state: "Yobe" },
  { name: "Gombe", region: "North East", state: "Gombe" },
  { name: "Jalingo", region: "North East", state: "Taraba" },
  { name: "Maidugu", region: "North East", state: "Borno" },
  { name: "Yola", region: "North East", state: "Adamawa" },
  // North West
  { name: "Birnin Ke", region: "North West", state: "Kebbi" },
  { name: "Dutse", region: "North West", state: "Jigawa" },
  { name: "Gusau", region: "North West", state: "Zamfara" },
  { name: "Kaduna", region: "North West", state: "Kaduna" },
  { name: "Kano", region: "North West", state: "Kano" },
  { name: "Katsina", region: "North West", state: "Katsina" },
  { name: "Sokoto", region: "North West", state: "Sokoto" },
  { name: "Zaria", region: "North West", state: "Kaduna" },
  // South West
  { name: "Abeokut", region: "South West", state: "Ogun" },
  { name: "Ado-Ekiti", region: "South West", state: "Ekiti" },
  { name: "Akure", region: "South West", state: "Ondo" },
  { name: "Ibadan", region: "South West", state: "Oyo" },
  { name: "Lagos Cit", region: "South West", state: "Lagos" },
  { name: "Ife", region: "South West", state: "Osun" },
];

const boxDimensions = [
  {
    categoryId: "S-01",
    displayName: "Small Shipping Box (S)",
    lengthCm: 30,
    widthCm: 22,
    heightCm: 22,
    bestFor: "Books/Tools",
    weightKgLimit: 10,
  },
  {
    categoryId: "M-02",
    displayName: "Medium Shipping Box (M)",
    lengthCm: 45,
    widthCm: 45,
    heightCm: 40,
    bestFor: "Clothing/Kitchenware",
    weightKgLimit: 20,
  },
  {
    categoryId: "L-03",
    displayName: "Large Shipping Box (L)",
    lengthCm: 45,
    widthCm: 45,
    heightCm: 70,
    bestFor: "Bedding/Pillows",
    weightKgLimit: 30,
  },
  {
    categoryId: "XL-04",
    displayName: "Extra Large Box (XL)",
    lengthCm: 60,
    widthCm: 60,
    heightCm: 60,
    bestFor: "Small Appliances",
    weightKgLimit: 35,
  },
  {
    categoryId: "BK-05",
    displayName: "Heavy Duty Book Box",
    lengthCm: 40,
    widthCm: 30,
    heightCm: 30,
    bestFor: "Documents/Files",
    weightKgLimit: 25,
  },
  {
    categoryId: "TC-06",
    displayName: "Tea Chest (Moving)",
    lengthCm: 60,
    widthCm: 50,
    heightCm: 50,
    bestFor: "Bulky Household",
    weightKgLimit: 30,
  },
  {
    categoryId: "WR-07",
    displayName: "Wardrobe Box",
    lengthCm: 60,
    widthCm: 50,
    heightCm: 100,
    bestFor: "Hanging Clothes",
    weightKgLimit: 25,
  },
  {
    categoryId: "LP-08",
    displayName: "Laptop/Electronics",
    lengthCm: 40,
    widthCm: 40,
    heightCm: 15,
    bestFor: "Computers/Tablets",
    weightKgLimit: 5,
  },
  {
    categoryId: "PL-09",
    displayName: "Quarter Pallet Box",
    lengthCm: 60,
    widthCm: 40,
    heightCm: 50,
    bestFor: "Bulk B2B",
    weightKgLimit: 100,
  },
  {
    categoryId: "PL-10",
    displayName: "Half Pallet Box",
    lengthCm: 80,
    widthCm: 60,
    heightCm: 70,
    bestFor: "Industrial Goods",
    weightKgLimit: 250,
  },
];

// Price bands per zone (from the Price sheet — 4 zones × 5 weight tiers)
// Using estimated base prices based on zone & weight (admin can update via API)
const priceBands = [
  // Zone 1 (same region, nearby cities)
  {
    zone: 1,
    minKg: 50,
    maxKg: 200,
    minTons: 0.05,
    maxTons: 0.2,
    minCartons: 2,
    maxCartons: 6,
    pricePerKg: 120,
    basePrice: 6000,
  },
  {
    zone: 1,
    minKg: 201,
    maxKg: 500,
    minTons: 0.2,
    maxTons: 0.5,
    minCartons: 7,
    maxCartons: 17,
    pricePerKg: 100,
    basePrice: null,
  },
  {
    zone: 1,
    minKg: 501,
    maxKg: 1000,
    minTons: 0.5,
    maxTons: 1,
    minCartons: 18,
    maxCartons: 35,
    pricePerKg: 85,
    basePrice: null,
  },
  {
    zone: 1,
    minKg: 1001,
    maxKg: 2000,
    minTons: 1,
    maxTons: 2,
    minCartons: 36,
    maxCartons: 72,
    pricePerKg: 70,
    basePrice: null,
  },
  {
    zone: 1,
    minKg: 2001,
    maxKg: null,
    minTons: 2,
    maxTons: null,
    minCartons: 73,
    maxCartons: null,
    pricePerKg: 55,
    basePrice: null,
  },
  // Zone 2
  {
    zone: 2,
    minKg: 50,
    maxKg: 200,
    minTons: 0.05,
    maxTons: 0.2,
    minCartons: 2,
    maxCartons: 6,
    pricePerKg: 180,
    basePrice: 9000,
  },
  {
    zone: 2,
    minKg: 201,
    maxKg: 500,
    minTons: 0.2,
    maxTons: 0.5,
    minCartons: 7,
    maxCartons: 17,
    pricePerKg: 150,
    basePrice: null,
  },
  {
    zone: 2,
    minKg: 501,
    maxKg: 1000,
    minTons: 0.5,
    maxTons: 1,
    minCartons: 18,
    maxCartons: 35,
    pricePerKg: 130,
    basePrice: null,
  },
  {
    zone: 2,
    minKg: 1001,
    maxKg: 2000,
    minTons: 1,
    maxTons: 2,
    minCartons: 36,
    maxCartons: 72,
    pricePerKg: 110,
    basePrice: null,
  },
  {
    zone: 2,
    minKg: 2001,
    maxKg: null,
    minTons: 2,
    maxTons: null,
    minCartons: 73,
    maxCartons: null,
    pricePerKg: 90,
    basePrice: null,
  },
  // Zone 3
  {
    zone: 3,
    minKg: 50,
    maxKg: 200,
    minTons: 0.05,
    maxTons: 0.2,
    minCartons: 2,
    maxCartons: 6,
    pricePerKg: 250,
    basePrice: 12500,
  },
  {
    zone: 3,
    minKg: 201,
    maxKg: 500,
    minTons: 0.2,
    maxTons: 0.5,
    minCartons: 7,
    maxCartons: 17,
    pricePerKg: 210,
    basePrice: null,
  },
  {
    zone: 3,
    minKg: 501,
    maxKg: 1000,
    minTons: 0.5,
    maxTons: 1,
    minCartons: 18,
    maxCartons: 35,
    pricePerKg: 180,
    basePrice: null,
  },
  {
    zone: 3,
    minKg: 1001,
    maxKg: 2000,
    minTons: 1,
    maxTons: 2,
    minCartons: 36,
    maxCartons: 72,
    pricePerKg: 155,
    basePrice: null,
  },
  {
    zone: 3,
    minKg: 2001,
    maxKg: null,
    minTons: 2,
    maxTons: null,
    minCartons: 73,
    maxCartons: null,
    pricePerKg: 130,
    basePrice: null,
  },
  // Zone 4 (cross-region, longest distance)
  {
    zone: 4,
    minKg: 50,
    maxKg: 200,
    minTons: 0.05,
    maxTons: 0.2,
    minCartons: 2,
    maxCartons: 6,
    pricePerKg: 350,
    basePrice: 17500,
  },
  {
    zone: 4,
    minKg: 201,
    maxKg: 500,
    minTons: 0.2,
    maxTons: 0.5,
    minCartons: 7,
    maxCartons: 17,
    pricePerKg: 300,
    basePrice: null,
  },
  {
    zone: 4,
    minKg: 501,
    maxKg: 1000,
    minTons: 0.5,
    maxTons: 1,
    minCartons: 18,
    maxCartons: 35,
    pricePerKg: 260,
    basePrice: null,
  },
  {
    zone: 4,
    minKg: 1001,
    maxKg: 2000,
    minTons: 1,
    maxTons: 2,
    minCartons: 36,
    maxCartons: 72,
    pricePerKg: 220,
    basePrice: null,
  },
  {
    zone: 4,
    minKg: 2001,
    maxKg: null,
    minTons: 2,
    maxTons: null,
    minCartons: 73,
    maxCartons: null,
    pricePerKg: 180,
    basePrice: null,
  },
];

async function main() {
  console.log("🌱 Seeding BowaGO database...");

  // ─── Super Admin ────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash("Admin@1234", 12);
  await prisma.user.upsert({
    where: { email: "superadmin@bowago.com" },
    update: {},
    create: {
      email: "superadmin@bowago.com",
      firstName: "Super",
      lastName: "Admin",
      passwordHash,
      role: "ADMIN",
      adminSubRole: "SUPER_ADMIN",
      isEmailVerified: true,
    },
  });
  console.log("✅ Super admin created: superadmin@bowago.com / Admin@1234");

  await prisma.user.upsert({
    where: { email: "logistics@bowago.com" },
    update: {},
    create: {
      email: "logistics@bowago.com",
      firstName: "Logistics",
      lastName: "Manager",
      passwordHash,
      role: "ADMIN",
      adminSubRole: "LOGISTICS_MANAGER",
      isEmailVerified: true,
    },
  });
  console.log(
    "✅ Logistics manager created: logistics@bowago.com / Admin@1234",
  );

  // ─── Cities ─────────────────────────────────────────────────────────────────
  for (const city of cities) {
    await prisma.city.upsert({
      where: { name: city.name },
      update: { region: city.region, state: city.state },
      create: city,
    });
  }
  console.log(`✅ ${cities.length} cities seeded`);

  // ─── Box Dimensions ──────────────────────────────────────────────────────────
  for (const dim of boxDimensions) {
    await prisma.boxDimension.upsert({
      where: { categoryId: dim.categoryId },
      update: dim,
      create: dim,
    });
  }
  console.log(`✅ ${boxDimensions.length} box dimensions seeded`);

  // ─── Price Bands ─────────────────────────────────────────────────────────────
  await prisma.priceBand.deleteMany(); // clear and re-seed
  await prisma.priceBand.createMany({ data: priceBands });
  console.log(`✅ ${priceBands.length} price bands seeded`);

  // ─── App Settings ─────────────────────────────────────────────────────────────
  const settings = [
    { key: "app_name", value: "BowaGO", type: "string", group: "general" },
    { key: "currency", value: "NGN", type: "string", group: "general" },
    {
      key: "fragile_surcharge_percent",
      value: "10",
      type: "number",
      group: "pricing",
    },
    {
      key: "insurance_rate_percent",
      value: "2",
      type: "number",
      group: "pricing",
    },
    { key: "min_weight_kg", value: "50", type: "number", group: "pricing" },
    { key: "max_weight_kg", value: "50000", type: "number", group: "pricing" },
  ];
  for (const s of settings) {
    await prisma.appSettings.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }
  console.log("✅ App settings seeded");

  console.log("\n🎉 Seeding complete!");
  console.log(
    "📝 NOTE: Import zone matrix and KM data using POST /api/v1/pricing/import with the Rating_For_BowaGO.xlsx file",
  );
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
