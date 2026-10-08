// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Outlet } from "react-router";
import NewsletterTabs from "~/components/newsletter/NewsletterTabs";

/**
 * Shell for the newsletter console. Lives inside the mailbox layout, so it
 * inherits the sidebar/header chrome and Cloudflare Access protection.
 */
export default function NewsletterLayout() {
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="shrink-0 pt-4">
				<h1 className="px-4 text-lg font-semibold text-kumo-default md:px-8">
					Newsletter
				</h1>
				<div className="mt-3">
					<NewsletterTabs />
				</div>
			</div>
			<div className="flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				<Outlet />
			</div>
		</div>
	);
}
