// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Empty } from "@cloudflare/kumo";
import { MegaphoneIcon } from "@phosphor-icons/react";

/**
 * Campaign list placeholder.
 *
 * The campaign pipeline (NewsletterDO, Queues, event subscriptions) lands in
 * P1/P2 of docs/newsletter-design.md. This route exists now so the newsletter
 * navigation has a stable landing page and no dead links.
 */
export default function NewsletterCampaignsRoute() {
	return (
		<Empty
			icon={<MegaphoneIcon size={48} className="text-kumo-inactive" />}
			title="No campaigns yet"
			description="Campaign creation, subscriber import and delivery progress arrive with the newsletter pipeline. API keys on the Settings tab are already usable today."
		/>
	);
}
