const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created } = require('../utils/helpers');

// ─── Public: List FAQs ────────────────────────────────────────────────────────
async function listFaqs(req, res) {
  const { category, search } = req.query;

  const faqs = await prisma.faqItem.findMany({
    where: {
      isActive: true,
      ...(category && { category }),
      ...(search && {
        OR: [
          { question: { contains: search, mode: 'insensitive' } },
          { answer: { contains: search, mode: 'insensitive' } },
        ],
      }),
    },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
  });

  const grouped = faqs.reduce((acc, faq) => {
    if (!acc[faq.category]) acc[faq.category] = [];
    acc[faq.category].push(faq);
    return acc;
  }, {});

  return success(res, { faqs, grouped });
}

// ─── Public: Featured FAQs (homepage) ────────────────────────────────────────
// Returns up to 4 FAQs marked isFeatured:true, ordered by sortOrder.
async function featuredFaqs(req, res) {
  const faqs = await prisma.faqItem.findMany({
    where: { isActive: true, isFeatured: true },
    orderBy: { sortOrder: 'asc' },
    take: 4,
  });
  return success(res, { faqs });
}

// ─── Admin: Create FAQ ────────────────────────────────────────────────────────
async function createFaq(req, res) {
  const { question, answer, category, sortOrder, isFeatured } = req.body;

  // Enforce max 4 featured
  if (isFeatured) {
    const featuredCount = await prisma.faqItem.count({
      where: { isFeatured: true, isActive: true },
    });
    if (featuredCount >= 4) {
      throw new ApiError(400, 'Maximum 4 FAQs can be featured on the homepage. Please un-feature an existing one first.');
    }
  }

  const faq = await prisma.faqItem.create({
    data: {
      question,
      answer,
      category: category || 'OTHER',
      sortOrder: sortOrder || 0,
      isFeatured: !!isFeatured,
      createdBy: req.user.id,
    },
  });

  return created(res, { faq }, 'FAQ created');
}

// ─── Admin: Update FAQ ────────────────────────────────────────────────────────
async function updateFaq(req, res) {
  const { id } = req.params;
  const { isFeatured, ...rest } = req.body;

  // Enforce max 4 featured when featuring a new one
  if (isFeatured === true) {
    const current = await prisma.faqItem.findUnique({ where: { id } });
    if (!current?.isFeatured) {
      const featuredCount = await prisma.faqItem.count({
        where: { isFeatured: true, isActive: true, NOT: { id } },
      });
      if (featuredCount >= 4) {
        throw new ApiError(400, 'Maximum 4 FAQs can be featured. Please un-feature an existing one first.');
      }
    }
  }

  const faq = await prisma.faqItem.update({
    where: { id },
    data: { ...rest, ...(isFeatured !== undefined && { isFeatured }) },
  });

  return success(res, { faq }, 'FAQ updated');
}

// ─── Admin: Delete FAQ ────────────────────────────────────────────────────────
async function deleteFaq(req, res) {
  const { id } = req.params;
  await prisma.faqItem.delete({ where: { id } });
  return success(res, {}, 'FAQ deleted');
}

// ─── Admin: Toggle Featured ───────────────────────────────────────────────────
async function toggleFeatured(req, res) {
  const { id } = req.params;
  const faq = await prisma.faqItem.findUnique({ where: { id } });
  if (!faq) throw new ApiError(404, 'FAQ not found');

  if (!faq.isFeatured) {
    const featuredCount = await prisma.faqItem.count({
      where: { isFeatured: true, isActive: true },
    });
    if (featuredCount >= 4) {
      throw new ApiError(400, 'Maximum 4 FAQs can be featured on the homepage. Un-feature one first.');
    }
  }

  const updated = await prisma.faqItem.update({
    where: { id },
    data: { isFeatured: !faq.isFeatured },
  });

  return success(res, { faq: updated }, updated.isFeatured ? 'Added to homepage' : 'Removed from homepage');
}

module.exports = { listFaqs, featuredFaqs, createFaq, updateFaq, deleteFaq, toggleFeatured };
