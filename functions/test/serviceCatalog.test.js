const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_SERVICES,
  buildServiceCatalog,
  normalizeServiceDocument,
  parseDurationMinutes,
  parsePriceCents,
} = require("../serviceCatalog");

function doc(id, data) {
  return {
    id,
    data: () => data,
  };
}

test("normalizes active service documents with legacy field shapes", () => {
  const service = normalizeServiceDocument("premium-doc", {
    title: " Lavagem Premium ",
    subtitle: " Detalhe completo ",
    duration: "45 min",
    prices: {
      passenger: "32,00€",
      suv: 34,
    },
    icon: "sparkles",
    featured: true,
    sortOrder: "2",
  });

  assert.equal(service.id, "premium-doc");
  assert.equal(service.name, "Lavagem Premium");
  assert.equal(service.description, "Detalhe completo");
  assert.equal(service.durationMinutes, 45);
  assert.equal(service.passengerPriceCents, 3200);
  assert.equal(service.suvPriceCents, 3400);
  assert.equal(service.iconKey, "sparkles");
  assert.equal(service.popular, true);
  assert.equal(service.sortOrder, 2);
});

test("buildServiceCatalog sorts active services and omits inactive documents", () => {
  const catalog = buildServiceCatalog([
    doc("interior", {
      name: "Interior",
      active: true,
      durationMinutes: 25,
      passengerPriceCents: 1600,
      sortOrder: 2,
    }),
    doc("inactive", {
      name: "Inactive",
      active: false,
      durationMinutes: 30,
      passengerPriceCents: 999,
      sortOrder: 1,
    }),
    doc("standard", {
      name: "Standard",
      active: true,
      durationMinutes: 30,
      passengerPriceCents: 2500,
      sortOrder: 1,
    }),
  ]);

  assert.equal(catalog.source, "firestore");
  assert.deepEqual(catalog.services.map((service) => service.id), ["standard", "interior"]);
  assert.equal(catalog.services[0].sortOrder, undefined);
});

test("buildServiceCatalog falls back to default services when Firestore is empty", () => {
  const catalog = buildServiceCatalog([]);

  assert.equal(catalog.source, "default");
  assert.deepEqual(
    catalog.services.map((service) => service.id),
    DEFAULT_SERVICES.map((service) => service.id),
  );
});

test("catalog parsers coerce duration and euro prices", () => {
  assert.equal(parseDurationMinutes("480 min"), 480);
  assert.equal(parseDurationMinutes("999 min"), 480);
  assert.equal(parsePriceCents("18,50€"), 1850);
  assert.equal(parsePriceCents(18.5), 1850);
  assert.equal(parsePriceCents(1850), 1850);
});
