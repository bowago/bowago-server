/**
 * seed-packaging-guides.js
 *
 * Seeds the packaging_guides table from content that used to be hardcoded
 * directly in the frontend (src/app/packaging-guide/page.tsx). That page is
 * now wired to fetch from GET /policies/packaging-guides instead of a
 * static array — this script is what makes sure the guide content that was
 * already written for the client doesn't get lost in that switch.
 *
 * Safe to re-run — upserts by title, doesn't duplicate.
 *
 * Usage:
 *   node prisma/seed-packaging-guides.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// ── General how-to-pack guidelines (category: GENERAL) ─────────────────────
const GUIDELINES = [
  {
    title: "Choose the Right Box",
    sortOrder: 0,
    body: [
      "Use a new, sturdy corrugated cardboard box.",
      "The box should be 2–3 inches larger than your item on all sides for cushioning.",
      "Never reuse damaged, wet, or weakened boxes.",
      "Use BowaGO standard boxes for guaranteed handling compatibility.",
    ],
  },
  {
    title: "Cushioning & Protection",
    sortOrder: 1,
    body: [
      "Wrap individual items in at least 5 cm of bubble wrap.",
      "Fill all empty space with foam peanuts, air pillows, or crumpled paper.",
      "Fragile items: double-box with 7 cm cushioning between boxes.",
      "Items must not shift when the sealed box is shaken.",
      "Electronics: use anti-static bubble wrap and original packaging where possible.",
    ],
  },
  {
    title: "Sealing Your Package",
    sortOrder: 2,
    body: [
      "Use the H-tape method: tape all seams including edges and corners.",
      "Use pressure-sensitive tape at least 5 cm wide.",
      "Never use string, rope, masking tape, or thin cellophane tape.",
      "Apply at least 3 strips of tape over the opening seam.",
    ],
  },
  {
    title: "Labelling",
    sortOrder: 3,
    body: [
      "Place the shipping label on the largest flat surface of the box.",
      "Never place labels over seams, tape, or corners.",
      "Include a secondary label inside in case the outer one is damaged.",
      "Remove or cover all old labels and barcodes from reused boxes.",
    ],
  },
];

// ── Category-specific tips. Schema's PackagingGuide.category enum is
// GENERAL | FRAGILE | DANGEROUS_GOODS | ELECTRONICS | CLOTHING — narrower
// than the frontend's original 6 labels, so a couple map onto the closest
// fit (Glassware/Artwork/Liquids → FRAGILE, Documents → GENERAL). ─────────
const SPECIAL = [
  { title: "Electronics", category: "ELECTRONICS", sortOrder: 10,
    body: "Anti-static wrap. 5 cm cushioning on all sides. Declare value for insurance. Mark 'FRAGILE – ELECTRONICS'." },
  { title: "Glassware", category: "FRAGILE", sortOrder: 11,
    body: "Wrap each piece individually. Use cell dividers. Double-box with 7 cm cushioning. Mark 'FRAGILE – GLASS'." },
  { title: "Clothing", category: "CLOTHING", sortOrder: 12,
    body: "Poly mailers for soft goods. Seal in plastic bag inside box to protect against moisture." },
  { title: "Documents", category: "GENERAL", sortOrder: 13,
    body: "Rigid cardboard envelopes. Never fold important documents. Mark 'DO NOT BEND'." },
  { title: "Artwork", category: "FRAGILE", sortOrder: 14,
    body: "Corner protectors on frames. Wrap in glassine paper before bubble wrap. Use art shipping box." },
  { title: "Liquids", category: "FRAGILE", sortOrder: 15,
    body: "Leak-proof primary container. Wrap in absorbent material. Seal in plastic bag. Mark 'THIS SIDE UP'." },
];

// ── Prohibited items (category: DANGEROUS_GOODS, isDangerous: true) ────────
// These are what the warehouse-rejection rules key off (dangerousGoods
// array returned by GET /policies/packaging-guides).
const PROHIBITED = [
  "Explosives, fireworks, and flammable substances",
  "Illegal drugs and narcotics",
  "Live animals (unless pre-approved with documentation)",
  "Perishable foods without prior approval",
  "Cash or negotiable instruments without declared value and insurance",
  "Lithium batteries exceeding airline transport limits",
  "Weapons, firearms, and ammunition without proper licensing",
  "Human remains without proper documentation",
  "Counterfeit or copyright-infringing materials",
];

function bulletBody(items) {
  return items.map((i) => `- ${i}`).join("\n");
}

async function upsertGuide({ title, body, category, sortOrder, isDangerous = false }) {
  const existing = await prisma.packagingGuide.findFirst({ where: { title } });
  const data = { title, body, category, sortOrder, isDangerous, isActive: true };
  if (existing) {
    await prisma.packagingGuide.update({ where: { id: existing.id }, data });
  } else {
    await prisma.packagingGuide.create({ data });
  }
  console.log(`  ✓ [${category}] ${title}`);
}

async function main() {
  console.log("\nSeeding packaging guides...\n");

  console.log("General guidelines:");
  for (const g of GUIDELINES) {
    await upsertGuide({
      title: g.title,
      body: bulletBody(g.body),
      category: "GENERAL",
      sortOrder: g.sortOrder,
    });
  }

  console.log("\nSpecial categories:");
  for (const s of SPECIAL) {
    await upsertGuide({
      title: s.title,
      body: s.body,
      category: s.category,
      sortOrder: s.sortOrder,
    });
  }

  console.log("\nProhibited / dangerous goods:");
  for (let i = 0; i < PROHIBITED.length; i++) {
    await upsertGuide({
      title: PROHIBITED[i],
      body: PROHIBITED[i],
      category: "DANGEROUS_GOODS",
      sortOrder: 20 + i,
      isDangerous: true,
    });
  }

  // Bonus: the "Weight Discrepancy Policy" paragraph from the same page
  // fits PolicyContent better than PackagingGuide (it's a policy, not a
  // how-to). Seeded here too since it came from the same page.
  await prisma.policyContent.upsert({
    where: { key: "weight_discrepancy_policy" },
    update: {},
    create: {
      key: "weight_discrepancy_policy",
      title: "Weight Discrepancy Policy",
      body:
        "If the actual weight or dimensions differ from what was declared at booking, " +
        "your shipment is placed on hold. You have 24 hours to pay any additional " +
        "charges before the shipment is automatically cancelled.",
      isActive: true,
    },
  });
  console.log("\n  ✓ [policy] Weight Discrepancy Policy");

  console.log("\nDone.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
