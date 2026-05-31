const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_EXTRAS,
  DEFAULT_SERVICES,
  buildServiceCatalog,
  normalizeExtraDocument,
  normalizeServiceDocument,
  parseDurationMinutes,
  parsePriceCents,
  validateAdminServiceCatalogArchiveInput,
  validateAdminServiceCatalogItemInput,
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
  assert.equal(catalog.extrasSource, "default");
  assert.deepEqual(catalog.services.map((service) => service.id), ["standard", "interior"]);
  assert.deepEqual(catalog.extras.map((extra) => extra.id), DEFAULT_EXTRAS.map((extra) => extra.id));
  assert.equal(catalog.services[0].sortOrder, undefined);
});

test("buildServiceCatalog omits disabled service documents", () => {
  const catalog = buildServiceCatalog([
    doc("disabled", {
      name: "Disabled",
      enabled: false,
      durationMinutes: 30,
      passengerPriceCents: 2500,
      sortOrder: 1,
    }),
    doc("enabled", {
      name: "Enabled",
      enabled: true,
      durationMinutes: 30,
      passengerPriceCents: 2500,
      sortOrder: 2,
    }),
  ]);

  assert.deepEqual(catalog.services.map((service) => service.id), ["enabled"]);
});

test("buildServiceCatalog falls back to default services when Firestore is empty", () => {
  const catalog = buildServiceCatalog([]);

  assert.equal(catalog.source, "default");
  assert.deepEqual(
    catalog.services.map((service) => service.id),
    DEFAULT_SERVICES.map((service) => service.id),
  );
  assert.deepEqual(
    catalog.extras.map((extra) => extra.id),
    DEFAULT_EXTRAS.map((extra) => extra.id),
  );
});

test("normalizes active service extra documents with legacy field shapes", () => {
  const extra = normalizeExtraDocument("wax-doc", {
    title: " Enceramento ",
    subtitle: " Proteção extra ",
    price: "15,00€",
    icon: "shield",
    sortOrder: "4",
  });

  assert.equal(extra.id, "wax-doc");
  assert.equal(extra.name, "Enceramento");
  assert.equal(extra.description, "Proteção extra");
  assert.equal(extra.priceCents, 1500);
  assert.equal(extra.iconKey, "shield");
  assert.equal(extra.sortOrder, 4);
});

test("buildServiceCatalog sorts active extras and omits inactive extras", () => {
  const catalog = buildServiceCatalog(
    [],
    [
      doc("odor", {
        name: "Tratamento de Odores",
        priceCents: 1200,
        sortOrder: 2,
      }),
      doc("inactive", {
        name: "Inactive",
        active: false,
        priceCents: 999,
        sortOrder: 1,
      }),
      doc("wax", {
        name: "Enceramento",
        price: "15,00€",
        sortOrder: 1,
      }),
    ],
  );

  assert.equal(catalog.source, "default");
  assert.equal(catalog.extrasSource, "firestore");
  assert.deepEqual(catalog.extras.map((extra) => extra.id), ["wax", "odor"]);
  assert.equal(catalog.extras[0].sortOrder, undefined);
});

test("catalog parsers coerce duration and euro prices", () => {
  assert.equal(parseDurationMinutes("480 min"), 480);
  assert.equal(parseDurationMinutes("999 min"), 480);
  assert.equal(parsePriceCents("18,50€"), 1850);
  assert.equal(parsePriceCents(18.5), 1850);
  assert.equal(parsePriceCents(1850), 1850);
});

test("validates and sanitizes admin service catalog payloads", () => {
  const parsed = validateAdminServiceCatalogItemInput({
    serviceId: " premium-detail ",
    name: " Lavagem   Premium ",
    description: " Detalhe   completo ",
    durationMinutes: 999,
    passengerPrice: "32,00€",
    suvPriceCents: 3400,
    iconKey: " sparkles ",
    popular: true,
    enabled: false,
    sortOrder: -4,
  });

  assert.equal(parsed.serviceId, "premium-detail");
  assert.deepEqual(parsed.document, {
    id: "premium-detail",
    name: "Lavagem Premium",
    description: "Detalhe completo",
    durationMinutes: 480,
    passengerPriceCents: 3200,
    suvPriceCents: 3400,
    iconKey: "sparkles",
    popular: true,
    active: false,
    enabled: false,
    sortOrder: 0,
  });
});

test("admin service catalog validation rejects path ids and missing prices", () => {
  assert.throws(
    () => validateAdminServiceCatalogItemInput({
      serviceId: "services/premium",
      name: "Premium",
      passengerPriceCents: 3200,
    }),
    /path separators/,
  );
  assert.throws(
    () => validateAdminServiceCatalogItemInput({
      serviceId: "premium",
      name: "Premium",
    }),
    /passengerPriceCents is required/,
  );
});

test("validates admin service archive payloads", () => {
  assert.deepEqual(
    validateAdminServiceCatalogArchiveInput({serviceId: "standard"}),
    {serviceId: "standard"},
  );
  assert.throws(
    () => validateAdminServiceCatalogArchiveInput({serviceId: "services/standard"}),
    /path separators/,
  );
});
