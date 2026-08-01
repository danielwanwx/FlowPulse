import assert from "node:assert/strict";
import test from "node:test";
import { exerciseCheckoutPaymentPath, readAllowlistedFlagVariant } from "../src/development-adapter.mjs";

test("creates a real Checkout to Payment verification transaction", async () => {
  const requests = [];
  await exerciseCheckoutPaymentPath({
    baseUrl: "http://astronomy.test",
    userId: "flowpulse-verification-test",
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return new Response("{}", { status: 200 });
    }
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://astronomy.test/api/cart");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(requests[0].init.headers, { "content-type": "application/json" });
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    item: { productId: "0PUK6V6EV0", quantity: 1 },
    userId: "flowpulse-verification-test"
  });
  assert.equal(requests[1].url, "http://astronomy.test/api/checkout");
  assert.equal(requests[1].init.method, "POST");
  assert.deepEqual(requests[1].init.headers, { "content-type": "application/json" });
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    email: "flowpulse-probe@example.com",
    address: { streetAddress: "1600 Amphitheatre Parkway", zipCode: "94043", city: "Mountain View", state: "CA", country: "United States" },
    userCurrency: "USD",
    creditCard: { creditCardNumber: "4432-8015-6152-0454", creditCardExpirationMonth: 1, creditCardExpirationYear: 2039, creditCardCvv: 672 },
    userId: "flowpulse-verification-test"
  });
});

test("reads only the checked-in development flag variant", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.FLOWPULSE_FLAGD_UI_URL;
  process.env.FLOWPULSE_FLAGD_UI_URL = "http://flagd.test";
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://flagd.test/api/read");
    return new Response(JSON.stringify({
      flags: {
        paymentUnreachable: { defaultVariant: "off", variants: { off: false, on: true } },
        unrelatedSecretFlag: { defaultVariant: "hidden" }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const state = await readAllowlistedFlagVariant();
    assert.equal(state.flag, "paymentUnreachable");
    assert.equal(state.variant, "off");
    assert.equal(state.source, "official flagd-ui API");
    assert.match(state.observed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(JSON.stringify(state).includes("unrelatedSecretFlag"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.FLOWPULSE_FLAGD_UI_URL;
    else process.env.FLOWPULSE_FLAGD_UI_URL = previousUrl;
  }
});

test("rejects a flagd response outside the checked-in variants", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.FLOWPULSE_FLAGD_UI_URL;
  process.env.FLOWPULSE_FLAGD_UI_URL = "http://flagd.test";
  globalThis.fetch = async () => new Response(JSON.stringify({
    flags: { paymentUnreachable: { defaultVariant: "arbitrary", variants: { off: false, on: true, arbitrary: true } } }
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(() => readAllowlistedFlagVariant(), /unavailable or invalid/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.FLOWPULSE_FLAGD_UI_URL;
    else process.env.FLOWPULSE_FLAGD_UI_URL = previousUrl;
  }
});

test("rejects allowlisted variant names whose boolean meanings are reversed", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.FLOWPULSE_FLAGD_UI_URL;
  process.env.FLOWPULSE_FLAGD_UI_URL = "http://flagd.test";
  globalThis.fetch = async () => new Response(JSON.stringify({
    flags: { paymentUnreachable: { defaultVariant: "off", variants: { off: true, on: false } } }
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(() => readAllowlistedFlagVariant(), /unavailable or invalid/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.FLOWPULSE_FLAGD_UI_URL;
    else process.env.FLOWPULSE_FLAGD_UI_URL = previousUrl;
  }
});
