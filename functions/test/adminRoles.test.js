const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertAdminRequest,
  authenticatedEmail,
  effectiveRoleFromRequest,
  getAllowlistedRole,
  normalizeRole,
  userRoleFromAuth,
} = require("../adminRoles");

test("effectiveRoleFromRequest prefers allowlist over stale token role", async () => {
  const db = fakeDb({
    "admin@example.com": {role: "employee"},
  });

  const role = await effectiveRoleFromRequest(db, request({
    email: " ADMIN@example.com ",
    role: "admin",
  }));

  assert.equal(role, "employee");
});

test("effectiveRoleFromRequest denies stale admin claim when email is no longer allowlisted", async () => {
  const role = await effectiveRoleFromRequest(fakeDb({}), request({
    email: "admin@example.com",
    role: "admin",
  }));

  assert.equal(role, null);
});

test("effectiveRoleFromRequest falls back to token role only when email is unavailable", async () => {
  const role = await effectiveRoleFromRequest(fakeDb({}), request({
    role: "admin",
  }));

  assert.equal(role, "admin");
});

test("assertAdminRequest requires current allowlisted admin role", async () => {
  const db = fakeDb({
    "admin@example.com": {role: "admin"},
    "employee@example.com": {role: "employee"},
  });

  await assert.doesNotReject(() => assertAdminRequest(db, request({
    email: "admin@example.com",
    role: "employee",
  })));
  await assert.rejects(
    () => assertAdminRequest(db, request({
      email: "employee@example.com",
      role: "admin",
    })),
    /Admin role required/,
  );
});

test("role helpers normalize supported roles and email", async () => {
  assert.equal(normalizeRole(" Admin "), "admin");
  assert.equal(normalizeRole("employee"), "employee");
  assert.equal(normalizeRole("customer"), null);
  assert.equal(authenticatedEmail(request({email: " ADMIN@EXAMPLE.COM "})), "admin@example.com");
  assert.equal(userRoleFromAuth(request({role: "ADMIN"})), "admin");
  assert.equal(await getAllowlistedRole(fakeDb({"admin@example.com": {role: " ADMIN "}}), " ADMIN@example.com "), "admin");
});

function request({email = "", role = ""} = {}) {
  return {
    auth: {
      uid: "uid-1",
      token: {
        email,
        role,
      },
    },
  };
}

function fakeDb(allowlist) {
  return {
    collection(name) {
      assert.equal(name, "admin_allowlist");
      return {
        doc(id) {
          return {
            async get() {
              const data = allowlist[id];
              return {
                exists: data !== undefined,
                get(field) {
                  return data?.[field];
                },
              };
            },
          };
        },
      };
    },
  };
}
