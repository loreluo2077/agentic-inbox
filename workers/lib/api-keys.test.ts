// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Unit tests for the API key helpers.
 *
 * These cover the compliance- and security-critical logic that would otherwise
 * only be exercised by live traffic: key format round-tripping, secret
 * hashing, capability sanitisation (including the deliberate absence of
 * `keys:admin`), and mailbox scope matching.
 */

import { describe, expect, it } from "vitest";
import {
	API_KEY_CAPABILITIES,
	API_KEY_PREFIX,
	API_KEY_SECRET_BYTES,
	bearerToken,
	filterAllowedMailboxes,
	generateApiKey,
	hasCapability,
	isKeyActive,
	isMailboxAllowed,
	normalizeMailboxIds,
	parseApiKey,
	parseStringArray,
	sanitizeCapabilities,
	sha256Hex,
	toApiKeyView,
} from "./api-keys";
import type { ApiKeyRecord } from "../durableObject/apikeys";

function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
	return {
		id: "ab12cd34",
		name: "Test key",
		prefix: `${API_KEY_PREFIX}_ab12cd34`,
		mailbox_ids: JSON.stringify(["news@example.com"]),
		capabilities: JSON.stringify(["subscribers:read"]),
		created_at: "2026-01-01T00:00:00.000Z",
		created_by: "tester@example.com",
		last_used_at: null,
		expires_at: null,
		revoked_at: null,
		...overrides,
	};
}

describe("sha256Hex", () => {
	it("matches the known SHA-256 vector for 'abc'", async () => {
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("generateApiKey", () => {
	it("produces a parseable key whose hash matches its secret", async () => {
		const generated = await generateApiKey();

		expect(generated.plaintext.startsWith(`${API_KEY_PREFIX}_${generated.keyId}_`)).toBe(true);
		expect(generated.prefix).toBe(`${API_KEY_PREFIX}_${generated.keyId}`);

		const parsed = parseApiKey(generated.plaintext);
		expect(parsed).not.toBeNull();
		expect(parsed?.keyId).toBe(generated.keyId);
		expect(parsed?.prefix).toBe(generated.prefix);
		expect(await sha256Hex(parsed!.secret)).toBe(generated.secretHash);
	});

	it("generates a 32-byte secret and unique keys", async () => {
		const first = await generateApiKey();
		const second = await generateApiKey();

		expect(parseApiKey(first.plaintext)!.secret).toHaveLength(
			Math.ceil((API_KEY_SECRET_BYTES * 4) / 3),
		);
		expect(first.plaintext).not.toBe(second.plaintext);
		expect(first.keyId).not.toBe(second.keyId);
	});

	it("never stores the plaintext secret", async () => {
		const generated = await generateApiKey();
		const secret = parseApiKey(generated.plaintext)!.secret;
		expect(generated.secretHash).not.toContain(secret);
	});
});

describe("parseApiKey", () => {
	it("accepts a well-formed key with surrounding whitespace", async () => {
		const generated = await generateApiKey();
		expect(parseApiKey(`  ${generated.plaintext}  `)?.keyId).toBe(generated.keyId);
	});

	it("rejects malformed input", () => {
		expect(parseApiKey("")).toBeNull();
		expect(parseApiKey("not-a-key")).toBeNull();
		expect(parseApiKey("ain_short_secret")).toBeNull();
		expect(parseApiKey("xyz_ab12cd34_aaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
		// keyId must be exactly 8 characters
		expect(parseApiKey("ain_ab12_aaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
		// secret must be long enough to be a real secret
		expect(parseApiKey("ain_ab12cd34_short")).toBeNull();
	});
});

describe("bearerToken", () => {
	it("extracts a token case-insensitively", () => {
		expect(bearerToken("Bearer abc123")).toBe("abc123");
		expect(bearerToken("bearer   abc123  ")).toBe("abc123");
	});

	it("rejects missing or non-bearer headers", () => {
		expect(bearerToken(undefined)).toBeNull();
		expect(bearerToken("")).toBeNull();
		expect(bearerToken("Basic abc123")).toBeNull();
		expect(bearerToken("abc123")).toBeNull();
	});
});

describe("parseStringArray", () => {
	it("parses JSON arrays of strings", () => {
		expect(parseStringArray('["a","b"]')).toEqual(["a", "b"]);
	});

	it("never throws on bad input", () => {
		expect(parseStringArray(null)).toEqual([]);
		expect(parseStringArray("")).toEqual([]);
		expect(parseStringArray("not json")).toEqual([]);
		expect(parseStringArray('{"a":1}')).toEqual([]);
		expect(parseStringArray('["a",1,null]')).toEqual(["a"]);
	});
});

describe("sanitizeCapabilities", () => {
	it("keeps known capabilities and removes duplicates", () => {
		expect(
			sanitizeCapabilities(["campaigns:send", "campaigns:send", "subscribers:read"]),
		).toEqual(["campaigns:send", "subscribers:read"]);
	});

	it("never grants keys:admin even if requested", () => {
		expect(sanitizeCapabilities(["keys:admin"])).toEqual([]);
		expect(sanitizeCapabilities(["keys:admin", "campaigns:read"])).toEqual([
			"campaigns:read",
		]);
	});

	it("drops unknown capabilities", () => {
		expect(sanitizeCapabilities(["nope", ""])).toEqual([]);
	});

	it("does not expose keys:admin in the published capability list", () => {
		expect(API_KEY_CAPABILITIES).not.toContain("keys:admin");
	});
});

describe("normalizeMailboxIds", () => {
	it("lowercases, trims and de-duplicates", () => {
		expect(normalizeMailboxIds([" News@Example.com ", "news@example.com", "*"])).toEqual([
			"news@example.com",
			"*",
		]);
	});

	it("drops empty entries", () => {
		expect(normalizeMailboxIds(["", "   "])).toEqual([]);
	});
});

describe("hasCapability", () => {
	it("reads capabilities from the stored JSON", () => {
		const record = makeRecord({ capabilities: JSON.stringify(["campaigns:send"]) });
		expect(hasCapability(record, "campaigns:send")).toBe(true);
		expect(hasCapability(record, "campaigns:read")).toBe(false);
	});

	it("fails closed when the stored JSON is corrupt", () => {
		expect(hasCapability(makeRecord({ capabilities: "{" }), "campaigns:send")).toBe(false);
	});
});

describe("isMailboxAllowed", () => {
	it("grants every mailbox for the * scope", () => {
		const record = makeRecord({ mailbox_ids: JSON.stringify(["*"]) });
		expect(isMailboxAllowed(record, "anything@example.com")).toBe(true);
	});

	it("matches scoped mailboxes case-insensitively", () => {
		const record = makeRecord({ mailbox_ids: JSON.stringify(["News@Example.com"]) });
		expect(isMailboxAllowed(record, "news@example.com")).toBe(true);
		expect(isMailboxAllowed(record, "other@example.com")).toBe(false);
	});

	it("denies everything when the scope is corrupt", () => {
		expect(isMailboxAllowed(makeRecord({ mailbox_ids: "oops" }), "news@example.com")).toBe(
			false,
		);
	});
});

describe("filterAllowedMailboxes", () => {
	const mailboxes = [
		{ id: "news@example.com", email: "news@example.com" },
		{ id: "hello@example.com", email: "hello@example.com" },
	];

	it("returns everything for the * scope", () => {
		expect(
			filterAllowedMailboxes(makeRecord({ mailbox_ids: JSON.stringify(["*"]) }), mailboxes),
		).toHaveLength(2);
	});

	it("returns only scoped mailboxes", () => {
		expect(
			filterAllowedMailboxes(
				makeRecord({ mailbox_ids: JSON.stringify(["news@example.com"]) }),
				mailboxes,
			),
		).toEqual([mailboxes[0]]);
	});
});

describe("isKeyActive", () => {
	it("is active without revocation or expiry", () => {
		expect(isKeyActive(makeRecord())).toBe(true);
	});

	it("is inactive once revoked", () => {
		expect(isKeyActive(makeRecord({ revoked_at: "2026-01-02T00:00:00.000Z" }))).toBe(false);
	});

	it("is inactive once expired", () => {
		const now = new Date("2026-06-01T00:00:00.000Z");
		expect(isKeyActive(makeRecord({ expires_at: "2026-05-31T00:00:00.000Z" }), now)).toBe(
			false,
		);
		expect(isKeyActive(makeRecord({ expires_at: "2026-06-02T00:00:00.000Z" }), now)).toBe(
			true,
		);
	});
});

describe("toApiKeyView", () => {
	it("expands JSON columns into arrays", () => {
		const view = toApiKeyView(
			makeRecord({
				mailbox_ids: JSON.stringify(["*"]),
				capabilities: JSON.stringify(["campaigns:send"]),
			}),
		);
		expect(view.mailboxIds).toEqual(["*"]);
		expect(view.capabilities).toEqual(["campaigns:send"]);
	});

	it("never leaks the secret hash", () => {
		const view = toApiKeyView(makeRecord());
		expect(Object.keys(view)).not.toContain("secret_hash");
		expect(JSON.stringify(view)).not.toContain("secret");
	});
});
