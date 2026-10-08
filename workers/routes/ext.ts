// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * External API surface, mounted at `/api/ext`.
 *
 * Reached with `Authorization: Bearer ain_<keyId>_<secret>` instead of
 * Cloudflare Access, so `/api/ext/*` is exempted from the Access middleware
 * in workers/app.ts and protected by `requireApiKey` alone.
 *
 * P0 exposes introspection only. Subscribers and campaigns are added in P1/P2.
 */

import { Hono } from "hono";
import { listMailboxes } from "../lib/email-helpers";
import { filterAllowedMailboxes, parseStringArray, toApiKeyView } from "../lib/api-keys";
import type { ApiKeyContext } from "../lib/api-keys";

export const extApp = new Hono<ApiKeyContext>();

extApp.notFound((c) => c.json({ error: "Not found" }, 404));

/** Introspection: which key is this, and what may it do. */
extApp.get("/v1/whoami", (c) => {
	const key = c.get("apiKey");
	return c.json({
		key: toApiKeyView(key),
		capabilities: parseStringArray(key.capabilities),
	});
});

/** Mailboxes visible to this key, already filtered by its mailbox scope. */
extApp.get("/v1/mailboxes", async (c) => {
	const key = c.get("apiKey");
	const all = await listMailboxes(c.env.BUCKET);
	return c.json({ mailboxes: filterAllowedMailboxes(key, all) });
});
