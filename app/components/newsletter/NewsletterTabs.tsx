// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { NavLink, useParams } from "react-router";

interface Tab {
	to: string;
	label: string;
	end?: boolean;
}

/**
 * Sub-navigation for the newsletter console.
 *
 * Only routes that exist are linked, so the sidebar never points at a 404.
 * "Subscribers" is added in P1 (it needs NewsletterDO).
 */
const TABS: Tab[] = [
	{ to: "", label: "Campaigns", end: true },
	{ to: "settings", label: "Settings" },
];

export default function NewsletterTabs() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const base = `/mailbox/${mailboxId}/newsletter`;

	return (
		<nav
			className="flex items-center gap-1 border-b border-kumo-line px-4 md:px-8"
			aria-label="Newsletter sections"
		>
			{TABS.map((tab) => {
				const to = tab.to ? `${base}/${tab.to}` : base;
				return (
					<NavLink
						key={tab.label}
						to={to}
						end={tab.end}
						className={({ isActive }) =>
							`-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
								isActive
									? "border-kumo-brand text-kumo-default"
									: "border-transparent text-kumo-subtle hover:text-kumo-strong"
							}`
						}
					>
						{tab.label}
					</NavLink>
				);
			})}
		</nav>
	);
}
