const {HttpsError} = require("firebase-functions/v2/https");

const DEFAULT_BUSINESS_INFO = {
  phone: "913 005 855",
  phoneUri: "tel:913005855",
  email: "info@sudsshine.pt",
  emailUri: "mailto:info@sudsshine.pt",
  addressLine1: "Shopping Norte Sul, Piso -1",
  addressLine2: "Leiria, Portugal",
  mapsUri: "https://www.google.com/maps/search/?api=1&query=Shopping+Norte+Sul+Leiria",
  whatsappUri: "https://wa.me/351913005855",
  openingHours: [
    {dayLabel: "Segunda a Sexta", hoursLabel: "09:00 - 19:00", closed: false},
    {dayLabel: "Sábado", hoursLabel: "09:00 - 13:00", closed: false},
    {dayLabel: "Domingo", hoursLabel: "Encerrado", closed: true},
  ],
  faq: [
    {
      question: "Como posso marcar uma lavagem?",
      answer: "Pode marcar através da app na secção Marcar, escolhendo o serviço, tipo de veículo, data e hora desejados. Também pode ligar para 913 005 855.",
    },
    {
      question: "Quanto tempo demora cada serviço?",
      answer: "Lavagem Exterior: 20 min, Lavagem Standard: 30 min, Limpeza Interior: 25 min, Lavagem Premium: 45 min.",
    },
    {
      question: "Como funciona o programa de fidelização?",
      answer: "A cada lavagem completa, recebe 1 selo. Quando completar 10 selos, ganha 1 lavagem grátis automaticamente.",
    },
    {
      question: "Posso cancelar ou remarcar?",
      answer: "Sim, pode cancelar ou remarcar até 2 horas antes da marcação através da app ou contactando-nos diretamente.",
    },
    {
      question: "Aceitam pagamento com cartão?",
      answer: "Sim, aceitamos pagamento em dinheiro, cartão de débito e crédito, e MB Way.",
    },
    {
      question: "Onde estão localizados?",
      answer: "Estamos localizados no Shopping Norte Sul, Piso -1, em Leiria. Temos estacionamento gratuito e fácil acesso.",
    },
  ],
  stats: [
    {value: "500+", label: "Carros Tratados"},
    {value: "4.9", label: "Avaliação Média"},
    {value: "3+", label: "Anos Experiência"},
  ],
  socialLinks: [],
};

const MAX_OPENING_HOURS = 10;
const MAX_SOCIAL_LINKS = 8;

function shortString(value, fallback, maxLength = 500) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function linkString(value, fallback) {
  return shortString(value, fallback, 1000);
}

function normalizeOpeningHours(value, fallback = DEFAULT_BUSINESS_INFO.openingHours) {
  if (!Array.isArray(value)) return fallback;

  const items = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const dayLabel = shortString(item.dayLabel || item.day || item.label, "", 80);
      const hoursLabel = shortString(item.hoursLabel || item.hours || item.value, "", 80);
      if (!dayLabel || !hoursLabel) return null;
      return {
        dayLabel,
        hoursLabel,
        closed: item.closed === true,
      };
    })
    .filter(Boolean)
    .slice(0, 10);

  return items.length > 0 ? items : fallback;
}

function normalizeFaq(value, fallback = DEFAULT_BUSINESS_INFO.faq) {
  if (!Array.isArray(value)) return fallback;

  const items = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const question = shortString(item.question, "", 180);
      const answer = shortString(item.answer, "", 1000);
      if (!question || !answer) return null;
      return {question, answer};
    })
    .filter(Boolean)
    .slice(0, 12);

  return items.length > 0 ? items : fallback;
}

function normalizeStats(value, fallback = DEFAULT_BUSINESS_INFO.stats) {
  if (!Array.isArray(value)) return fallback;

  const items = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const statValue = shortString(item.value, "", 40);
      const label = shortString(item.label, "", 80);
      if (!statValue || !label) return null;
      return {value: statValue, label};
    })
    .filter(Boolean)
    .slice(0, 4);

  return items.length > 0 ? items : fallback;
}

function normalizeSocialLinks(value, fallback = DEFAULT_BUSINESS_INFO.socialLinks) {
  if (!Array.isArray(value)) return fallback;

  const items = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const label = shortString(item.label || item.name, "", 80);
      const uri = linkString(item.uri || item.url || item.href, "");
      if (!label || !uri) return null;
      return {label, uri};
    })
    .filter(Boolean)
    .slice(0, MAX_SOCIAL_LINKS);

  return items.length > 0 ? items : fallback;
}

function settingPayload(data) {
  if (!data || typeof data !== "object") return {};
  const nested = data.value && typeof data.value === "object" ? data.value : null;
  return nested || data;
}

function buildBusinessInfo(docSnap = null) {
  const source = docSnap?.exists ? settingPayload(docSnap.data()) : {};
  const address = source.address && typeof source.address === "object" ? source.address : {};
  const contact = source.contact && typeof source.contact === "object" ? source.contact : {};

  return {
    phone: shortString(contact.phone || source.phone, DEFAULT_BUSINESS_INFO.phone, 60),
    phoneUri: linkString(contact.phoneUri || source.phoneUri, DEFAULT_BUSINESS_INFO.phoneUri),
    email: shortString(contact.email || source.email, DEFAULT_BUSINESS_INFO.email, 320),
    emailUri: linkString(contact.emailUri || source.emailUri, DEFAULT_BUSINESS_INFO.emailUri),
    addressLine1: shortString(
      address.line1 || source.addressLine1,
      DEFAULT_BUSINESS_INFO.addressLine1,
      160,
    ),
    addressLine2: shortString(
      address.line2 || source.addressLine2,
      DEFAULT_BUSINESS_INFO.addressLine2,
      160,
    ),
    mapsUri: linkString(address.mapsUri || source.mapsUri, DEFAULT_BUSINESS_INFO.mapsUri),
    whatsappUri: linkString(contact.whatsappUri || source.whatsappUri, DEFAULT_BUSINESS_INFO.whatsappUri),
    openingHours: normalizeOpeningHours(source.openingHours || source.hours),
    faq: normalizeFaq(source.faq),
    stats: normalizeStats(source.stats),
    socialLinks: normalizeSocialLinks(source.socialLinks),
    source: docSnap?.exists ? "firestore" : "default",
  };
}

function assertBusinessInfoReadable(info) {
  if (
    !info ||
    !info.phone ||
    !info.email ||
    !info.addressLine1 ||
    !Array.isArray(info.openingHours) ||
    !Array.isArray(info.faq) ||
    !Array.isArray(info.stats)
  ) {
    throw new HttpsError("internal", "Business info could not be built");
  }
}

function requiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new HttpsError("invalid-argument", `${fieldName} is too long`);
  }
  return trimmed;
}

function requiredUri(value, fieldName) {
  const uri = requiredString(value, fieldName, 1000);
  let parsed;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid URL`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpsError("invalid-argument", `${fieldName} must be a web URL`);
  }
  return uri;
}

function normalizePhoneUri(phone) {
  const normalized = phone.replace(/[^\d+]/g, "");
  if (!normalized || normalized.length < 6) {
    throw new HttpsError("invalid-argument", "phone is invalid");
  }
  return `tel:${normalized}`;
}

function normalizeEmailUri(email) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "email is invalid");
  }
  return `mailto:${email}`;
}

function validateOpeningHoursInput(value) {
  if (!Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "openingHours is required");
  }

  const items = value
    .slice(0, MAX_OPENING_HOURS)
    .map((item) => {
      if (!item || typeof item !== "object") {
        throw new HttpsError("invalid-argument", "openingHours entries must be objects");
      }
      return {
        dayLabel: requiredString(item.dayLabel || item.day, "dayLabel", 80),
        hoursLabel: requiredString(item.hoursLabel || item.hours, "hoursLabel", 80),
        closed: item.closed === true,
      };
    });

  if (items.length === 0) {
    throw new HttpsError("invalid-argument", "openingHours must include at least one row");
  }
  return items;
}

function validateSocialLinksInput(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "socialLinks must be a list");
  }

  return value
    .slice(0, MAX_SOCIAL_LINKS)
    .map((item) => {
      if (!item || typeof item !== "object") {
        throw new HttpsError("invalid-argument", "socialLinks entries must be objects");
      }
      return {
        label: requiredString(item.label || item.name, "socialLink.label", 80),
        uri: requiredUri(item.uri || item.url || item.href, "socialLink.uri"),
      };
    });
}

function validateBusinessInfoUpdateInput(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Business info payload is required");
  }

  const phone = requiredString(data.phone, "phone", 60);
  const email = requiredString(data.email, "email", 320).toLowerCase();
  const addressLine1 = requiredString(data.addressLine1, "addressLine1", 160);
  const addressLine2 = requiredString(data.addressLine2, "addressLine2", 160);
  const mapsUri = requiredUri(data.mapsUri, "mapsUri");
  const whatsappUri = requiredUri(data.whatsappUri, "whatsappUri");

  return {
    phone,
    phoneUri: normalizePhoneUri(phone),
    email,
    emailUri: normalizeEmailUri(email),
    addressLine1,
    addressLine2,
    mapsUri,
    whatsappUri,
    openingHours: validateOpeningHoursInput(data.openingHours),
    socialLinks: validateSocialLinksInput(data.socialLinks),
  };
}

function buildBusinessInfoSettingValue(info) {
  return {
    contact: {
      phone: info.phone,
      phoneUri: info.phoneUri,
      email: info.email,
      emailUri: info.emailUri,
      whatsappUri: info.whatsappUri,
    },
    address: {
      line1: info.addressLine1,
      line2: info.addressLine2,
      mapsUri: info.mapsUri,
    },
    openingHours: info.openingHours,
    socialLinks: info.socialLinks,
  };
}

module.exports = {
  DEFAULT_BUSINESS_INFO,
  assertBusinessInfoReadable,
  buildBusinessInfoSettingValue,
  buildBusinessInfo,
  normalizeFaq,
  normalizeOpeningHours,
  normalizeSocialLinks,
  normalizeStats,
  validateBusinessInfoUpdateInput,
};
