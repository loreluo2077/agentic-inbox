// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useParams } from "react-router";
import { ShieldIcon } from "@phosphor-icons/react";
import ApiKeyManager from "~/components/newsletter/ApiKeyManager";

export default function NewsletterSettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();

	return (
		<div className="max-w-4xl space-y-6">
			<ApiKeyManager mailboxId={mailboxId} />

			{/* Sending configuration is wired up in P2/P3 — stated plainly so the
			    page never implies settings that do nothing. */}
			<section className="rounded-lg border border-kumo-line bg-kumo-base p-5">
				<div className="flex items-center gap-2">
					<ShieldIcon size={16} weight="duotone" className="text-kumo-subtle" />
					<span className="text-sm font-medium text-kumo-default">
						Sending configuration
					</span>
				</div>
				<p className="mt-1 text-xs leading-relaxed text-kumo-subtle">
					From name, reply-to, daily send limit and the campaign composer are part
					of the send pipeline (P2/P3) and are not configurable yet.
				</p>
				<ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-kumo-subtle">
					<li>
						• <strong className="text-kumo-strong">Access bypass required:</strong>{" "}
						add a bypass policy for <code className="font-mono">/api/ext/*</code>{" "}
						and <code className="font-mono">/unsubscribe*</code>, otherwise
						Cloudflare Access blocks external callers before they reach the Worker.
					</li>
					<li>
						• <strong className="text-kumo-strong">Sending domain:</strong> the
						domain used for campaigns must be onboarded to Cloudflare Email Service
						before it can send to arbitrary recipients.
					</li>
					<li>
						• <strong className="text-kumo-strong">Compliance:</strong> every
						campaign must carry one-click unsubscribe headers; subscribers need
						recorded consent.
					</li>
				</ul>
			</section>
		</div>
	);
}
