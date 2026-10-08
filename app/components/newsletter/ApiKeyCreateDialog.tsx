// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Dialog, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import RevealOncePanel from "./RevealOncePanel";
import { useCreateApiKey } from "~/queries/newsletter";
import { useMailboxes } from "~/queries/mailboxes";
import type { CreatedApiKey } from "~/types";

interface ApiKeyCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Pre-selected mailbox, typically the one currently being viewed. */
	defaultMailboxId?: string;
	/** Capability list published by the API, so the UI cannot invent one. */
	availableCapabilities: string[];
}

const CAPABILITY_LABELS: Record<string, string> = {
	"subscribers:read": "Read subscribers",
	"subscribers:write": "Add, update and unsubscribe subscribers",
	"campaigns:read": "Read campaigns and their stats",
	"campaigns:write": "Create and edit campaign drafts",
	"campaigns:send": "Trigger a campaign send",
};

export default function ApiKeyCreateDialog({
	open,
	onOpenChange,
	defaultMailboxId,
	availableCapabilities,
}: ApiKeyCreateDialogProps) {
	const { data: mailboxes = [], isLoading: mailboxesLoading } = useMailboxes();
	const createKey = useCreateApiKey();
	const toastManager = useKumoToastManager();

	const [name, setName] = useState("");
	const [allMailboxes, setAllMailboxes] = useState(false);
	const [selectedMailboxes, setSelectedMailboxes] = useState<string[]>([]);
	const [capabilities, setCapabilities] = useState<string[]>([]);
	const [expiresAt, setExpiresAt] = useState("");
	const [created, setCreated] = useState<CreatedApiKey | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Reset on every open so a previous key's secret never lingers on screen.
	useEffect(() => {
		if (!open) return;
		setName("");
		setAllMailboxes(false);
		setSelectedMailboxes(defaultMailboxId ? [defaultMailboxId.toLowerCase()] : []);
		setCapabilities([]);
		setExpiresAt("");
		setCreated(null);
		setError(null);
	}, [open, defaultMailboxId]);

	const toggle = (list: string[], value: string, setList: (next: string[]) => void) => {
		setList(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);

		const mailboxIds = allMailboxes ? ["*"] : selectedMailboxes;
		if (!name.trim()) return setError("Give the key a name so it can be identified later.");
		if (mailboxIds.length === 0) return setError("Select at least one mailbox.");
		if (capabilities.length === 0) return setError("Select at least one capability.");

		try {
			const result = await createKey.mutateAsync({
				name: name.trim(),
				mailboxIds,
				capabilities,
				expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59Z`).toISOString() : null,
			});
			setCreated(result);
			toastManager.add({ title: "API key created" });
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to create API key");
		}
	};

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next && createKey.isPending) return;
				onOpenChange(next);
			}}
		>
			<Dialog size="lg" className="p-6 max-h-[85vh] overflow-y-auto">
				<Dialog.Title className="text-base font-semibold mb-4">
					{created ? "API key created" : "Create API key"}
				</Dialog.Title>

				{created ? (
					<div className="space-y-4">
						<RevealOncePanel plaintext={created.plaintext} />
						<div className="flex justify-end gap-2">
							<Button variant="primary" onClick={() => onOpenChange(false)}>
								Done
							</Button>
						</div>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="space-y-5">
						{error && <Banner variant="error" text={error} />}

						<Input
							label="Name"
							placeholder="e.g. Newsletter service (staging)"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
						/>

						<fieldset className="space-y-2">
							<legend className="text-xs font-medium text-kumo-strong">
								Mailbox access
							</legend>

							<label className="flex items-center gap-2 text-xs text-kumo-default">
								<input
									type="checkbox"
									checked={allMailboxes}
									onChange={(e) => setAllMailboxes(e.target.checked)}
								/>
								All mailboxes (including ones created later)
							</label>

							{!allMailboxes && (
								<div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-recessed p-2">
									{mailboxesLoading && <Loader size="sm" />}
									{!mailboxesLoading && mailboxes.length === 0 && (
										<p className="text-xs text-kumo-subtle">
											No mailboxes exist yet.
										</p>
									)}
									{mailboxes.map((mailbox) => (
										<label
											key={mailbox.id}
											className="flex items-center gap-2 text-xs text-kumo-default"
										>
											<input
												type="checkbox"
												checked={selectedMailboxes.includes(
													mailbox.id.toLowerCase(),
												)}
												onChange={() =>
													toggle(
														selectedMailboxes,
														mailbox.id.toLowerCase(),
														setSelectedMailboxes,
													)
												}
											/>
											{mailbox.email || mailbox.id}
										</label>
									))}
								</div>
							)}
						</fieldset>

						<fieldset className="space-y-2">
							<legend className="text-xs font-medium text-kumo-strong">
								Capabilities
							</legend>
							{availableCapabilities.map((capability) => (
								<label
									key={capability}
									className="flex items-start gap-2 text-xs text-kumo-default"
								>
									<input
										type="checkbox"
										className="mt-0.5"
										checked={capabilities.includes(capability)}
										onChange={() =>
											toggle(capabilities, capability, setCapabilities)
										}
									/>
									<span>
										<span className="font-mono">{capability}</span>
										<span className="block text-kumo-subtle">
											{CAPABILITY_LABELS[capability] ?? ""}
										</span>
									</span>
								</label>
							))}
							<p className="text-[11px] text-kumo-subtle">
								Key management is intentionally not a capability: a leaked key
								must never be able to mint or revoke keys.
							</p>
						</fieldset>

						<Input
							label="Expires (optional)"
							type="date"
							value={expiresAt}
							onChange={(e) => setExpiresAt(e.target.value)}
						/>

						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								loading={createKey.isPending}
								disabled={!name.trim()}
							>
								Create key
							</Button>
						</div>
					</form>
				)}
			</Dialog>
		</Dialog.Root>
	);
}
