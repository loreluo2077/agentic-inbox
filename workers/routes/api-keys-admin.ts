// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * API key management endpoints, mounted at `/api/v1/api-keys`.
 *
 * These are protected by Cloudflare Access (they are NOT under `/api/ext/*`),
 * so only an operator signed in through Access can mint or revoke keys.
 * `keys:admin` intentionally does not exist as an API-key capability.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
	API_KEY_CAPABILITIES,
	generateApiKey,
	getApiKeysStub,
	normalizeMailboxIds,
	sanitizeCapabilities,
	toApiKeyView,
} from "../lib/api-keys";

const CreateApiKeyBody = z.object({
	name: z.string().trim().min(1).max(80),
	mailboxIds: z.array(z.string()).min(1),
	capabilities: z.array(z.string()).min(1),
	expiresAt: z.string().trim().min(1).nullish(),
});

export const apiKeysAdminApp = new Hono<{ Bindings: Env }>();

// ── List ───────────────────────────────────────────────────────────

apiKeysAdminApp.get("/", async (c) => {
	const keys = await getApiKeysStub(c.env).listKeys();
	return c.json({
		keys: keys.map(toApiKeyView),
		availableCapabilities: API_KEY_CAPABILITIES,
	});
});

// ── Create ─────────────────────────────────────────────────────────

apiKeysAdminApp.post("/", async (c) => {
	const body = CreateApiKeyBody.parse(await c.req.json());

	const capabilities = sanitizeCapabilities(body.capabilities);
	if (capabilities.length === 0) {
		return c.json(
			{
				error: "At least one valid capability is required",
				validCapabilities: API_KEY_CAPABILITIES,
			},
			400,
		);
	}

	const mailboxIds = normalizeMailboxIds(body.mailboxIds);
	if (mailboxIds.length === 0) {
		return c.json({ error: "At least one mailbox is required" }, 400);
	}

	let expiresAt: string | null = null;
	if (body.expiresAt) {
		const parsed = Date.parse(body.expiresAt);
		if (Number.isNaN(parsed)) {
			return c.json({ error: "expiresAt must be a parseable date" }, 400);
		}
		if (parsed <= Date.now()) {
			return c.json({ error: "expiresAt must be in the future" }, 400);
		}
		expiresAt = new Date(parsed).toISOString();
	}

	const generated = await generateApiKey();
	const record = await getApiKeysStub(c.env).insertKey({
		id: generated.keyId,
		name: body.name,
		prefix: generated.prefix,
		secretHash: generated.secretHash,
		mailboxIds,
		capabilities,
		createdBy: accessIdentity(c),
		expiresAt,
	});

	// `plaintext` is the only time the secret is ever returned.
	return c.json({ key: toApiKeyView(record), plaintext: generated.plaintext }, 201);
});

// ── Revoke ─────────────────────────────────────────────────────────

apiKeysAdminApp.delete("/:id", async (c) => {
	const revoked = await getApiKeysStub(c.env).revokeKey(c.req.param("id"));
	if (!revoked) {
		return c.json({ error: "API key not found or already revoked" }, 404);
	}
	return c.body(null, 204);
});

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Best-effort operator identity for the audit trail.
 *
 * The Access JWT has already been verified by the global middleware, so the
 * payload is only decoded here to attribute the action — never trusted on its
 * own for authorization.
 */
function accessIdentity(c: Context<{ Bindings: Env }>): string {
	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) return "local-dev";

	const payload = token.split(".")[1];
	if (!payload) return "access";

	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		const claims = JSON.parse(atob(padded)) as { email?: string; sub?: string };
		return claims.email || claims.sub || "access";
	} catch {
		return "access";
	}
}
