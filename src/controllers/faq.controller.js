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

  // Group by category for frontend
  const grouped = faqs.reduce((acc, faq) => {
    if (!acc[faq.category]) acc[faq.category] = [];
    acc[faq.category].push(faq);
    return acc;
  }, {});

  return success(res, { faqs, grouped });
}

// ─── Admin: Create FAQ ────────────────────────────────────────────────────────
async function createFaq(req, res) {
  const { question, answer, category, sortOrder } = req.body;

  const faq = await prisma.faqItem.create({
    data: {
      question,
      answer,
      category: category || 'OTHER',
      sortOrder: sortOrder || 0,
      createdBy: req.user.id,
    },
  });

  return created(res, { faq }, 'FAQ created');
}

// ─── Admin: Update FAQ ────────────────────────────────────────────────────────
async function updateFaq(req, res) {
  const { id } = req.params;

  const faq = await prisma.faqItem.update({
    where: { id },
    data: req.body,
  });

  return success(res, { faq }, 'FAQ updated');
}

// ─── Admin: Delete FAQ ────────────────────────────────────────────────────────
async function deleteFaq(req, res) {
  const { id } = req.params;
  await prisma.faqItem.delete({ where: { id } });
  return success(res, {}, 'FAQ deleted');
}

module.exports = { listFaqs, createFaq, updateFaq, deleteFaq };
