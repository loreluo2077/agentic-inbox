// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Centralised query key factories for cache invalidation. */
export const queryKeys = {
	mailboxes: {
		all: ["mailboxes"] as const,
		detail: (id: string) => ["mailboxes", id] as const,
	},
	emails: {
		list: (mailboxId: string, params: Record<string, string>) =>
			["emails", mailboxId, params] as const,
		detail: (mailboxId: string, emailId: string) =>
			["emails", mailboxId, emailId] as const,
		thread: (mailboxId: string, threadId: string) =>
			["emails", mailboxId, "thread", threadId] as const,
	},
	folders: {
		list: (mailboxId: string) => ["folders", mailboxId] as const,
	},
	search: {
		results: (mailboxId: string, query: string, page: number) =>
			["search", mailboxId, query, page] as const,
	},
	/**
	 * Newsletter (see docs/newsletter-design.md §12.5). Everything hangs off
	 * the `newsletter` prefix so a single invalidation clears the whole area.
	 */
	newsletter: {
		campaigns: (mailboxId: string) =>
			["newsletter", mailboxId, "campaigns"] as const,
		campaign: (mailboxId: string, campaignId: string) =>
			["newsletter", mailboxId, "campaign", campaignId] as const,
		subscribers: (mailboxId: string, params: Record<string, string>) =>
			["newsletter", mailboxId, "subscribers", params] as const,
		settings: (mailboxId: string) =>
			["newsletter", mailboxId, "settings"] as const,
		quota: (mailboxId: string) => ["newsletter", mailboxId, "quota"] as const,
		apiKeys: () => ["newsletter", "apiKeys"] as const,
	},
	config: ["config"] as const,
};
