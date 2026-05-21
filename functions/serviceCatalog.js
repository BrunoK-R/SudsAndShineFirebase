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
  if (data.active === false) return null;

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

function normalizeExtraDocument(docId, data) {
  if (!data || typeof data !== "object") return null;
  if (data.active === false) return null;

  const id = String(data.id || docId || "").trim();
  const name = String(data.name || data.title || "").trim();
  if (!id || !name) return null;

  return {
    id,
    name,
    description: String(data.description || data.subtitle || "").trim(),
    priceCents: parsePriceCents(data.priceCents ?? data.price, 0),
    iconKey: String(data.iconKey || data.icon || "auto_awesome").trim() || "auto_awesome",
    sortOrder: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 999,
  };
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

module.exports = {
  DEFAULT_EXTRAS,
  DEFAULT_SERVICES,
  assertCatalogReadable,
  buildServiceCatalog,
  normalizeExtraDocument,
  normalizeServiceDocument,
  parseDurationMinutes,
  parsePriceCents,
};
