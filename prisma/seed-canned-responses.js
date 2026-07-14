/**
 * seed-canned-responses.js
 *
 * Seeds the 5 most commonly needed canned support responses — the ones an
 * agent reaches for constantly (tracking status, delay apology, payment/
 * refund status, claim next-steps, and a general closing) so the "Insert
 * Canned Response" picker in the ticket reply box isn't empty on a fresh
 * install.
 *
 * Categories match what's already used in the admin Canned Responses page
 * (General / Payment / Tracking / Delay / Claims) — see
 * frontend/src/app/dashboard/support/canned-responses/page.tsx.
 *
 * Safe to re-run: upserts by title, so running it twice won't create
 * duplicates or clobber an agent's edits to a response with a different
 * title.
 *
 * Usage:
 *   node prisma/seed-canned-responses.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CANNED_RESPONSES = [
  {
    title: "Shipment Tracking Status",
    category: "Tracking",
    body:
      "Hi {{customerName}},\n\n" +
      "Thanks for reaching out! I checked your shipment {{trackingNumber}} and here's the latest update:\n\n" +
      "Current status: {{status}}\n" +
      "Last known location: {{location}}\n" +
      "Estimated delivery: {{estimatedDelivery}}\n\n" +
      "You can also track it live anytime at bowago.com/track/{{trackingNumber}}. Let me know if you have any other questions!",
  },
  {
    title: "Delay Apology & Next Steps",
    category: "Delay",
    body:
      "Hi {{customerName}},\n\n" +
      "I'm really sorry for the delay with shipment {{trackingNumber}} — I know that's frustrating, especially when you're expecting it.\n\n" +
      "Here's what's happening: {{delayReason}}\n\n" +
      "Your new estimated delivery date is {{newEstimatedDelivery}}. We're actively monitoring this shipment and I'll update you the moment there's a change. Thank you for your patience.",
  },
  {
    title: "Payment / Refund Status",
    category: "Payment",
    body:
      "Hi {{customerName}},\n\n" +
      "Thanks for checking in on your payment for shipment {{trackingNumber}}.\n\n" +
      "Status: {{paymentStatus}}\n" +
      "{{#if refundInitiated}}Your refund of ₦{{refundAmount}} was initiated on {{refundDate}} and should reflect in your account within 3–5 business days via {{refundMethod}}.{{/if}}\n\n" +
      "Let me know if you'd like me to look into anything else on this.",
  },
  {
    title: "Claim Filed — Next Steps",
    category: "Claims",
    body:
      "Hi {{customerName}},\n\n" +
      "I've received your claim for shipment {{trackingNumber}} and it's now under review by our claims team.\n\n" +
      "What happens next:\n" +
      "1. Our team reviews the details and any photos/documents you provided (typically within 3–5 business days)\n" +
      "2. You'll get a notification the moment a decision is made\n" +
      "3. If approved, any applicable refund is processed automatically\n\n" +
      "You can check your claim's status anytime under My Claims in your dashboard. I'll personally follow up if anything needs your input.",
  },
  {
    title: "General Closing — Anything Else?",
    category: "General",
    body:
      "Glad I could help with that, {{customerName}}! Is there anything else I can assist you with today?\n\n" +
      "If not, this ticket will be marked resolved — but feel free to reply anytime if the issue comes back or you think of something else. Thanks for choosing BowaGO!",
  },
];

async function main() {
  console.log(`\nSeeding ${CANNED_RESPONSES.length} canned responses...\n`);

  for (const response of CANNED_RESPONSES) {
    const existing = await prisma.cannedResponse.findFirst({
      where: { title: response.title },
    });

    if (existing) {
      await prisma.cannedResponse.update({
        where: { id: existing.id },
        data: {
          body: response.body,
          category: response.category,
          isActive: true,
        },
      });
      console.log(`  ↻ Updated: "${response.title}"`);
    } else {
      await prisma.cannedResponse.create({
        data: {
          title: response.title,
          body: response.body,
          category: response.category,
          isActive: true,
        },
      });
      console.log(`  ✓ Created: "${response.title}"`);
    }
  }

  console.log(
    `\nDone. Agents will see these in the "Insert Canned Response" picker\n` +
      `when replying to any ticket.\n`,
  );
}

main()
  .catch((err) => {
    console.error("\nSeed failed:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
