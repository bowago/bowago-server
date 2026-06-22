/**
 * Seed FAQ items — run once to populate the database.
 * Usage: node src/scripts/seed-faqs.js
 * Safe to re-run (upserts on question text).
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const FAQS = [
  { question: 'How do I track my shipment?', answer: 'Enter your tracking number on the Track page or homepage. No login required — tracking is public.', category: 'TRACKING', sortOrder: 1, isFeatured: true },
  { question: 'How is shipping cost calculated?', answer: 'Cost is based on origin, destination, zone, and billable weight (higher of actual or volumetric weight).', category: 'PRICING', sortOrder: 2, isFeatured: true },
  { question: 'What is Express vs Standard vs Economy?', answer: 'Express is 1–3 business days. Standard is 5–7 business days. Economy is 10–14 business days. All tiers include live tracking.', category: 'SHIPPING_RULES', sortOrder: 3, isFeatured: true },
  { question: 'Can I insure my shipment?', answer: 'Yes — add insurance at checkout. Premium is 2.5% of declared goods value, minimum ₦100.', category: 'SHIPPING_RULES', sortOrder: 4, isFeatured: true },
  { question: 'What payment methods do you accept?', answer: 'We accept card payments (Visa, Mastercard) via Paystack, bank transfers, and USSD. Cash and POS are accepted at pickup for offline bookings.', category: 'PAYMENTS', sortOrder: 5, isFeatured: false },
  { question: 'How do I create an account?', answer: 'Click "Sign Up" on the homepage, fill in your name, email, and password. You will receive an OTP to verify your email before logging in.', category: 'ACCOUNT', sortOrder: 6, isFeatured: false },
  { question: 'What items are prohibited?', answer: 'We do not ship hazardous materials, firearms, live animals, perishable goods without proper packaging, or items banned by Nigerian law.', category: 'SHIPPING_RULES', sortOrder: 7, isFeatured: false },
  { question: 'How do I file a claim for a damaged shipment?', answer: 'Go to My Support → Claims in your dashboard, fill in the claim form, and upload photos of the damage. Claims must be filed within 48 hours of delivery.', category: 'CLAIMS', sortOrder: 8, isFeatured: false },
  { question: 'What is the maximum weight per shipment?', answer: 'Standard shipments can be up to 2,000 kg. For heavier freight, contact us for a custom quote.', category: 'SHIPPING_RULES', sortOrder: 9, isFeatured: false },
  { question: 'Do you offer packaging materials?', answer: 'Yes — boxes of various sizes (S to XL), pallet boxes, and laptop/electronics packaging are available at our pickup centres.', category: 'PACKAGING', sortOrder: 10, isFeatured: false },
];

async function main() {
  console.log(`Seeding ${FAQS.length} FAQ items...`);
  let created = 0, updated = 0;
  for (const faq of FAQS) {
    const existing = await prisma.faqItem.findFirst({ where: { question: { equals: faq.question, mode: 'insensitive' } } });
    if (existing) {
      await prisma.faqItem.update({ where: { id: existing.id }, data: faq });
      updated++;
      console.log(`  ✏  Updated: "${faq.question.slice(0, 60)}"`);
    } else {
      await prisma.faqItem.create({ data: faq });
      created++;
      console.log(`  ✅  Created: "${faq.question.slice(0, 60)}"`);
    }
  }
  console.log(`\nDone. Created: ${created}, Updated: ${updated}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
