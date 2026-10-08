// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";

interface RevealOncePanelProps {
	plaintext: string;
}

/**
 * Shows a freshly minted API key exactly once.
 *
 * Only the SHA-256 digest is stored server-side, so this is the last time the
 * secret can be read — the UI must say so unambiguously.
 */
export default function RevealOncePanel({ plaintext }: RevealOncePanelProps) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(plaintext);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API unavailable or permission denied — the key is still
			// selectable by hand, so this stays silent.
		}
	};

	const handleDownload = () => {
		const blob = new Blob([`${plaintext}\n`], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "agentic-inbox-api-key.txt";
		anchor.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="space-y-3">
			<div className="flex items-start gap-2 rounded-lg border border-kumo-warning/40 bg-kumo-warning/10 px-3 py-2.5">
				<WarningIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-kumo-warning" />
				<p className="text-xs leading-relaxed text-kumo-strong">
					Copy this key now. It is shown <strong>once</strong> — only a hash is
					stored, so it can never be displayed again.
				</p>
			</div>

			<div className="flex items-center gap-1.5">
				<code className="min-w-0 flex-1 break-all rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2.5 font-mono text-[11px] leading-relaxed text-kumo-default">
					{plaintext}
				</code>
				<Tooltip content={copied ? "Copied!" : "Copy"} asChild>
					<Button
						variant="secondary"
						shape="square"
						size="sm"
						icon={
							copied ? (
								<CheckIcon size={12} weight="bold" className="text-kumo-success" />
							) : (
								<CopyIcon size={12} />
							)
						}
						onClick={handleCopy}
						aria-label="Copy API key"
					/>
				</Tooltip>
			</div>

			<Button variant="ghost" size="xs" onClick={handleDownload}>
				Download as .txt
			</Button>
		</div>
	);
}
