const {HttpsError} = require("firebase-functions/v2/https");

const DEFAULT_SERVICES = [
  {
    id: "standard",
    name: "Lavagem Standard",
    description: "Lavagem completa exterior e interior",
    durationMinutes: 30,
    passengerPriceCents: 2500,
    suvPriceCents: 2700,
    iconKey: "car",
    popular: false,
    sortOrder: 10,
  },
  {
    id: "premium",
    name: "Lavagem Premium",
    description: "Lavagem detalhada com acabamento premium",
    durationMinutes: 45,
    passengerPriceCents: 3200,
    suvPriceCents: 3400,
    iconKey: "sparkles",
    popular: true,
    sortOrder: 20,
  },
  {
    id: "exterior",
    name: "Lavagem Exterior",
    description: "Apenas lavagem exterior",
    durationMinutes: 20,
    passengerPriceCents: 1600,
    suvPriceCents: 1850,
    iconKey: "water_drop",
    popular: false,
    sortOrder: 30,
  },
  {
    id: "interior",
    name: "Limpeza do Interior",
    description: "Apenas limpeza interior",
    durationMinutes: 25,
    passengerPriceCents: 1600,
    suvPriceCents: 1850,
    iconKey: "weekend",
    popular: false,
    sortOrder: 40,
  },
];

const DEFAULT_EXTRAS = [
  {
    id: "wax",
    name: "Enceramento",
    description: "Proteção e brilho extra para a pintura",
    priceCents: 1500,
    iconKey: "shield",
    sortOrder: 10,
  },
  {
    id: "vacuum",
    name: "Aspiração Profunda",
    description: "Limpeza intensiva de tapetes e interiores",
    priceCents: 800,
    iconKey: "air",
    sortOrder: 20,
  },
  {
    id: "tires",
    name: "Brilho de Pneus",
    description: "Acabamento escuro e proteção lateral",
    priceCents: 500,
    iconKey: "circle",
    sortOrder: 30,
  },
  {
    id: "odor",
    name: "Tratamento de Odores",
    description: "Neutralização de odores no habitáculo",
    priceCents: 1200,
    iconKey: "air",
    sortOrder: 40,
  },
  {
    id: "upholstery",
    name: "Limpeza de Estofos",
    description: "Tratamento localizado para tecidos e bancos",
    priceCents: 2000,
    iconKey: "weekend",
    sortOrder: 50,
  },
];

function parseDurationMinutes(value, fallback = 30) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(5, Math.min(480, Math.floor(value)));
  }

  if (typeof value === "string" && value.trim()) {
    const digits = value.match(/\d+/)?.[0];
    if (digits) {
      const parsed = Number(digits);
      if (Number.isFinite(parsed)) {
        return Math.max(5, Math.min(480, Math.floor(parsed)));
      }
    }
  }

  return fallback;
}

function parsePriceCents(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value > 999 ? value : value * 100));
  }

  if (typeof value === "string" && value.trim()) {
    const normalized = value
      .replace("€", "")
      .replace(/\s/g, "")
      .replace(",", ".");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed > 999 ? parsed : parsed * 100));
    }
  }

  return fallback;
}

function readPrice(data, vehicleKey, fallback) {
  const centsKey = `${vehicleKey}PriceCents`;
  const priceKey = `${vehicleKey}Price`;
  const prices = data.prices && typeof data.prices === "object" ? data.prices : {};

  const candidates = [
    data[centsKey],
    data[priceKey],
    prices[vehicleKey],
    prices[`${vehicleKey}Cents`],
  ];

  for (const candidate of candidates) {
    const parsed = parsePriceCents(candidate, null);
    if (parsed !== null) return parsed;
  }

  return fallback;
}

function normalizeServiceDocument(docId, data) {
  if (!data || typeof data !== "object") return null;
  if (data.active === false || data.enabled === false) return null;

  const id = String(data.id || docId || "").trim();
  const name = String(data.name || data.title || "").trim();
  if (!id || !name) return null;

  const durationMinutes = parseDurationMinutes(data.durationMinutes || data.duration, 30);
  const passengerPriceCents = readPrice(data, "passenger", 0);
  const suvPriceCents = readPrice(data, "suv", passengerPriceCents);

  return {
    id,
    name,
    description: String(data.description || data.subtitle || "").trim(),
    durationMinutes,
    passengerPriceCents,
    suvPriceCents,
    iconKey: String(data.iconKey || data.icon || "car").trim() || "car",
    popular: data.popular === true || data.featured === true,
    sortOrder: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 999,
  };
}

function normalizeAdminServiceDocument(docId, data) {
  if (!data || typeof data !== "object") return null;

  const id = String(data.id || docId || "").trim();
  const name = String(data.name || data.title || "").trim();
  if (!id || !name) return null;

  const durationMinutes = parseDurationMinutes(data.durationMinutes || data.duration, 30);
  const passengerPriceCents = readPrice(data, "passenger", 0);
  const suvPriceCents = readPrice(data, "suv", passengerPriceCents);
  const active = data.active === false || data.enabled === false ? false : true;

  return {
    id,
    name,
    description: String(data.description || data.subtitle || "").trim(),
    durationMinutes,
    passengerPriceCents,
    suvPriceCents,
    iconKey: String(data.iconKey || data.icon || "car").trim() || "car",
    popular: data.popular === true || data.featured === true,
    active,
    sortOrder: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 999,
    createdAtIso: timestampToIso(data.createdAt),
    updatedAtIso: timestampToIso(data.updatedAt),
    archivedAtIso: timestampToIso(data.archivedAt),
    createdByUid: String(data.createdByUid || "").trim(),
    updatedByUid: String(data.updatedByUid || "").trim(),
    archivedByUid: String(data.archivedByUid || "").trim(),
  };
}

function normalizeExtraDocument(docId, data) {
  if (!data || typeof data !== "object") return null;
  if (data.active === false || data.enabled === false) return null;

  const id = String(data.id || docId || "").trim();
  const name = String(data.name || data.title || "").trim();
  if (!id || !name) return null;

  return {
    id,
    name,
    description: String(data.description || data.subtitle || "").trim(),
    priceCents: parsePriceCents(data.priceCents ?? data.price, 0),
    iconKey: String(data.iconKey || data.icon || "auto_awesome").trim() || "auto_awesome",
    eligibleServiceIds: normalizePublicEligibleServiceIds(data.eligibleServiceIds || data.serviceIds),
    sortOrder: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 999,
  };
}

function normalizeAdminExtraDocument(docId, data) {
  if (!data || typeof data !== "object") return null;

  const id = String(data.id || docId || "").trim();
  const name = String(data.name || data.title || "").trim();
  if (!id || !name) return null;
  const active = data.active === false || data.enabled === false ? false : true;

  return {
    id,
    name,
    description: String(data.description || data.subtitle || "").trim(),
    priceCents: parsePriceCents(data.priceCents ?? data.price, 0),
    iconKey: String(data.iconKey || data.icon || "auto_awesome").trim() || "auto_awesome",
    eligibleServiceIds: normalizePublicEligibleServiceIds(data.eligibleServiceIds || data.serviceIds),
    active,
    sortOrder: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 999,
  };
}

function normalizePublicEligibleServiceIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const id = String(raw || "").trim();
    if (!id || id.includes("/") || id.includes("\\") || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(0, 40);
}

function normalizeSortedDocs(docs, normalize) {
  return (docs || [])
    .map((doc) => normalize(doc.id, doc.data()))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.name.localeCompare(right.name, "pt");
    })
    .map(({sortOrder, ...item}) => item);
}

function buildAdminServiceCatalog(serviceDocs = []) {
  const services = (serviceDocs || [])
    .map((doc) => normalizeAdminServiceDocument(doc.id, doc.data()))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.name.localeCompare(right.name, "pt");
    });

  if (services.length > 0) {
    return {
      services,
      source: "firestore",
    };
  }

  return {
    services: DEFAULT_SERVICES.map((service) => ({
      ...service,
      active: true,
    })),
    source: "default",
  };
}

function buildAdminServiceExtras(extraDocs = []) {
  const extras = (extraDocs || [])
    .map((doc) => normalizeAdminExtraDocument(doc.id, doc.data()))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.name.localeCompare(right.name, "pt");
    });

  if (extras.length > 0) {
    return {
      extras,
      source: "firestore",
    };
  }

  return {
    extras: DEFAULT_EXTRAS.map((extra) => ({
      ...extra,
      eligibleServiceIds: [],
      active: true,
    })),
    source: "default",
  };
}

function buildServiceCatalog(serviceDocs, extraDocs = []) {
  const services = normalizeSortedDocs(serviceDocs, normalizeServiceDocument);
  const extras = normalizeSortedDocs(extraDocs, normalizeExtraDocument);

  if (services.length > 0) {
    return {
      services,
      extras: extras.length > 0 ? extras : DEFAULT_EXTRAS.map(({sortOrder, ...extra}) => extra),
      source: "firestore",
      extrasSource: extras.length > 0 ? "firestore" : "default",
    };
  }

  return {
    services: DEFAULT_SERVICES.map(({sortOrder, ...service}) => service),
    extras: extras.length > 0 ? extras : DEFAULT_EXTRAS.map(({sortOrder, ...extra}) => extra),
    source: "default",
    extrasSource: extras.length > 0 ? "firestore" : "default",
  };
}

function assertCatalogReadable(catalog) {
  if (!catalog || !Array.isArray(catalog.services) || !Array.isArray(catalog.extras)) {
    throw new HttpsError("internal", "Service catalog could not be built");
  }
}

function assertPlainObject(data, label) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", `${label} must be an object`);
  }
}

function normalizeAdminCatalogId(value, fieldName, fallbackId = "") {
  const candidate = String(value || fallbackId || "").trim();
  if (!candidate) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  if (candidate.includes("/") || candidate.includes("\\")) {
    throw new HttpsError("invalid-argument", `${fieldName} cannot contain path separators`);
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(candidate)) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must contain only letters, numbers, underscores, or hyphens`,
    );
  }
  return candidate;
}

function normalizeAdminText(value, fieldName, {required = false, maxLength = 500, fallback = ""} = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpsError("invalid-argument", `${fieldName} is required`);
    return fallback;
  }
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${fieldName} must be a string`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (required && !normalized) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  if (normalized.length > maxLength) {
    throw new HttpsError("invalid-argument", `${fieldName} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeAdminInteger(value, fieldName, {min = 0, max = 9999, fallback = null} = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallback === null) throw new HttpsError("invalid-argument", `${fieldName} is required`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a number`);
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeAdminPriceCents(value, fieldName, fallback = null) {
  const parsed = parsePriceCents(value, fallback);
  if (parsed === null) {
    throw new HttpsError("invalid-argument", `${fieldName} is required`);
  }
  return Math.max(0, Math.min(100000, parsed));
}

function normalizeAdminBoolean(value, fieldName, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new HttpsError("invalid-argument", `${fieldName} must be a boolean`);
  }
  return value;
}

function normalizeAdminEligibleServiceIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "eligibleServiceIds must be an array");
  }
  if (value.length > 40) {
    throw new HttpsError("invalid-argument", "eligibleServiceIds supports at most 40 services");
  }

  const ids = [];
  const seen = new Set();
  for (const rawId of value) {
    const id = normalizeAdminCatalogId(rawId, "eligibleServiceIds");
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function timestampToIso(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value.toDate === "function") {
    const parsed = value.toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "";
  }
  if (Number.isFinite(value.seconds)) {
    const nanoseconds = Number.isFinite(value.nanoseconds) ? value.nanoseconds : 0;
    const parsed = new Date(value.seconds * 1000 + Math.floor(nanoseconds / 1000000));
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  return "";
}

function validateAdminServiceCatalogItemInput(data = {}, fallbackId = "") {
  assertPlainObject(data, "service payload");
  const serviceId = normalizeAdminCatalogId(data.serviceId ?? data.id, "serviceId", fallbackId);
  const name = normalizeAdminText(data.name, "name", {required: true, maxLength: 120});
  const description = normalizeAdminText(data.description, "description", {maxLength: 1000});
  const durationMinutes = normalizeAdminInteger(data.durationMinutes, "durationMinutes", {
    min: 5,
    max: 480,
    fallback: 30,
  });
  const passengerPriceCents = normalizeAdminPriceCents(
    data.passengerPriceCents ?? data.passengerPrice,
    "passengerPriceCents",
  );
  const suvPriceCents = normalizeAdminPriceCents(
    data.suvPriceCents ?? data.suvPrice,
    "suvPriceCents",
    passengerPriceCents,
  );
  const iconKey = normalizeAdminText(data.iconKey ?? data.icon, "iconKey", {
    maxLength: 40,
    fallback: "car",
  }) || "car";
  const popular = normalizeAdminBoolean(data.popular, "popular", false);
  const active = normalizeAdminBoolean(data.active ?? data.enabled, "active", true);
  const sortOrder = normalizeAdminInteger(data.sortOrder, "sortOrder", {
    min: 0,
    max: 9999,
    fallback: 999,
  });

  return {
    serviceId,
    document: {
      id: serviceId,
      name,
      description,
      durationMinutes,
      passengerPriceCents,
      suvPriceCents,
      iconKey,
      popular,
      active,
      enabled: active,
      sortOrder,
    },
  };
}

function validateAdminServiceCatalogArchiveInput(data = {}) {
  assertPlainObject(data, "archive payload");
  return {
    serviceId: normalizeAdminCatalogId(data.serviceId ?? data.id, "serviceId"),
  };
}

function validateAdminServiceExtraInput(data = {}, fallbackId = "") {
  assertPlainObject(data, "extra payload");
  const extraId = normalizeAdminCatalogId(data.extraId ?? data.id, "extraId", fallbackId);
  const name = normalizeAdminText(data.name, "name", {required: true, maxLength: 120});
  const description = normalizeAdminText(data.description, "description", {maxLength: 1000});
  const priceCents = normalizeAdminPriceCents(data.priceCents ?? data.price, "priceCents");
  const iconKey = normalizeAdminText(data.iconKey ?? data.icon, "iconKey", {
    maxLength: 40,
    fallback: "auto_awesome",
  }) || "auto_awesome";
  const eligibleServiceIds = normalizeAdminEligibleServiceIds(data.eligibleServiceIds ?? data.serviceIds);
  const active = normalizeAdminBoolean(data.active ?? data.enabled, "active", true);
  const sortOrder = normalizeAdminInteger(data.sortOrder, "sortOrder", {
    min: 0,
    max: 9999,
    fallback: 999,
  });

  return {
    extraId,
    document: {
      id: extraId,
      name,
      description,
      priceCents,
      iconKey,
      eligibleServiceIds,
      active,
      enabled: active,
      sortOrder,
    },
  };
}

function validateAdminServiceExtraArchiveInput(data = {}) {
  assertPlainObject(data, "archive payload");
  return {
    extraId: normalizeAdminCatalogId(data.extraId ?? data.id, "extraId"),
  };
}

module.exports = {
  DEFAULT_EXTRAS,
  DEFAULT_SERVICES,
  assertCatalogReadable,
  buildAdminServiceCatalog,
  buildAdminServiceExtras,
  buildServiceCatalog,
  normalizeAdminExtraDocument,
  normalizeAdminServiceDocument,
  normalizeExtraDocument,
  normalizeServiceDocument,
  parseDurationMinutes,
  parsePriceCents,
  validateAdminServiceCatalogArchiveInput,
  validateAdminServiceCatalogItemInput,
  validateAdminServiceExtraArchiveInput,
  validateAdminServiceExtraInput,
};
