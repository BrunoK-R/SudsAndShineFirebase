const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_EXTRAS,
  DEFAULT_SERVICES,
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

test("buildAdminServiceCatalog includes inactive services with admin metadata", () => {
  const inactive = normalizeAdminServiceDocument("disabled", {
    title: " Lavagem Desativada ",
    duration: "45 min",
    passengerPrice: "32,00€",
    suvPriceCents: 3400,
    icon: "sparkles",
    featured: true,
    enabled: false,
    sortOrder: "3",
  });

  assert.equal(inactive.id, "disabled");
  assert.equal(inactive.name, "Lavagem Desativada");
  assert.equal(inactive.active, false);
  assert.equal(inactive.sortOrder, 3);

  const catalog = buildAdminServiceCatalog([
    doc("enabled", {
      name: "Enabled",
      enabled: true,
      durationMinutes: 30,
      passengerPriceCents: 2500,
      sortOrder: 2,
    }),
    doc("disabled", {
      name: "Disabled",
      enabled: false,
      durationMinutes: 30,
      passengerPriceCents: 2500,
      sortOrder: 1,
    }),
  ]);

  assert.equal(catalog.source, "firestore");
  assert.deepEqual(catalog.services.map((service) => service.id), ["disabled", "enabled"]);
  assert.equal(catalog.services[0].active, false);
  assert.equal(catalog.services[0].sortOrder, 1);
});

test("buildAdminServiceCatalog falls back to default active services", () => {
  const catalog = buildAdminServiceCatalog([]);

  assert.equal(catalog.source, "default");
  assert.deepEqual(
    catalog.services.map((service) => service.id),
    DEFAULT_SERVICES.map((service) => service.id),
  );
  assert.equal(catalog.services.every((service) => service.active), true);
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

test("buildServiceCatalog omits disabled extra documents", () => {
  const catalog = buildServiceCatalog(
    [],
    [
      doc("disabled", {
        name: "Disabled",
        enabled: false,
        priceCents: 1000,
        sortOrder: 1,
      }),
      doc("enabled", {
        name: "Enabled",
        enabled: true,
        priceCents: 1200,
        sortOrder: 2,
      }),
    ],
  );

  assert.deepEqual(catalog.extras.map((extra) => extra.id), ["enabled"]);
});

test("buildAdminServiceExtras includes inactive extras with admin metadata", () => {
  const inactive = normalizeAdminExtraDocument("wax", {
    title: " Enceramento ",
    subtitle: " Proteção extra ",
    price: "15,00€",
    icon: "shield",
    serviceIds: ["premium", "standard"],
    enabled: false,
    sortOrder: "3",
  });

  assert.equal(inactive.id, "wax");
  assert.equal(inactive.name, "Enceramento");
  assert.equal(inactive.priceCents, 1500);
  assert.equal(inactive.active, false);
  assert.deepEqual(inactive.eligibleServiceIds, ["premium", "standard"]);

  const catalog = buildAdminServiceExtras([
    doc("odor", {
      name: "Tratamento de Odores",
      priceCents: 1200,
      enabled: true,
      sortOrder: 2,
    }),
    doc("wax", {
      name: "Enceramento",
      priceCents: 1500,
      enabled: false,
      sortOrder: 1,
    }),
  ]);

  assert.equal(catalog.source, "firestore");
  assert.deepEqual(catalog.extras.map((extra) => extra.id), ["wax", "odor"]);
  assert.equal(catalog.extras[0].active, false);
  assert.equal(catalog.extras[0].sortOrder, 1);
});

test("buildAdminServiceExtras falls back to default active extras", () => {
  const catalog = buildAdminServiceExtras([]);

  assert.equal(catalog.source, "default");
  assert.deepEqual(
    catalog.extras.map((extra) => extra.id),
    DEFAULT_EXTRAS.map((extra) => extra.id),
  );
  assert.equal(catalog.extras.every((extra) => extra.active), true);
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

test("validates and sanitizes admin service extra payloads", () => {
  const parsed = validateAdminServiceExtraInput({
    extraId: " wax ",
    name: " Enceramento   Premium ",
    description: " Proteção   extra ",
    price: "15,00€",
    iconKey: " shield ",
    eligibleServiceIds: [" premium ", "standard", "premium"],
    enabled: false,
    sortOrder: -4,
  });

  assert.equal(parsed.extraId, "wax");
  assert.deepEqual(parsed.document, {
    id: "wax",
    name: "Enceramento Premium",
    description: "Proteção extra",
    priceCents: 1500,
    iconKey: "shield",
    eligibleServiceIds: ["premium", "standard"],
    active: false,
    enabled: false,
    sortOrder: 0,
  });
});

test("admin service extra validation rejects path ids and malformed service links", () => {
  assert.throws(
    () => validateAdminServiceExtraInput({
      extraId: "extras/wax",
      name: "Wax",
      priceCents: 1500,
    }),
    /path separators/,
  );
  assert.throws(
    () => validateAdminServiceExtraInput({
      extraId: "wax",
      name: "Wax",
      priceCents: 1500,
      eligibleServiceIds: ["services/premium"],
    }),
    /path separators/,
  );
});

test("validates admin service extra archive payloads", () => {
  assert.deepEqual(
    validateAdminServiceExtraArchiveInput({extraId: "wax"}),
    {extraId: "wax"},
  );
  assert.throws(
    () => validateAdminServiceExtraArchiveInput({extraId: "service_extras/wax"}),
    /path separators/,
  );
});
