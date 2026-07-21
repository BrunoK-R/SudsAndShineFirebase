const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildUserProfile,
  validateUserProfilePayload,
} = require("../userProfile");

test("buildUserProfile falls back to auth token fields", () => {
  const result = buildUserProfile({
    uid: "uid-1",
    authToken: {
      email: "Bruno@Example.com",
      name: "Bruno Ribeiro",
      phone_number: "+351 913 005 855",
    },
    userDoc: {exists: false},
  });

  assert.deepEqual(result.profile, {
    uid: "uid-1",
    email: "bruno@example.com",
    displayName: "Bruno Ribeiro",
    phoneNumber: "+351 913 005 855",
    photoUrl: "",
    marketingOptIn: false,
    appointmentReminderOptIn: false,
  });
});

test("buildUserProfile prefers stored profile data", () => {
  const result = buildUserProfile({
    uid: "uid-1",
    authToken: {
      email: "auth@example.com",
      name: "Auth Name",
    },
    userDoc: doc({
      email: "stored@example.com",
      displayName: "Stored Name",
      phoneNumber: "913005855",
      photoUrl: " https://cdn.example.com/profile.jpg ",
      marketingOptIn: true,
      appointmentReminderOptIn: true,
    }),
  });

  assert.equal(result.profile.email, "stored@example.com");
  assert.equal(result.profile.displayName, "Stored Name");
  assert.equal(result.profile.phoneNumber, "913005855");
  assert.equal(result.profile.photoUrl, "https://cdn.example.com/profile.jpg");
  assert.equal(result.profile.marketingOptIn, true);
  assert.equal(result.profile.appointmentReminderOptIn, true);
});

test("validateUserProfilePayload normalizes editable fields", () => {
  const profile = validateUserProfilePayload({
    displayName: "  Bruno Ribeiro  ",
    phoneNumber: " +351 913 005 855 ",
    marketingOptIn: true,
    appointmentReminderOptIn: true,
  });

  assert.deepEqual(profile, {
    displayName: "Bruno Ribeiro",
    phoneNumber: "+351 913 005 855",
    marketingOptIn: true,
    appointmentReminderOptIn: true,
  });
});

test("validateUserProfilePayload rejects invalid phone numbers", () => {
  assert.throws(
    () => validateUserProfilePayload({
      displayName: "Bruno Ribeiro",
      phoneNumber: "abc",
    }),
    /phoneNumber is invalid/,
  );
});

function doc(data) {
  return {
    exists: true,
    data: () => data,
  };
}
