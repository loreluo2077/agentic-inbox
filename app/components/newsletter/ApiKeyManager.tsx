// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon, KeyIcon, PlusIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import ApiKeyCreateDialog from "./ApiKeyCreateDialog";
import { useApiKeys, useRevokeApiKey } from "~/queries/newsletter";
import { formatDetailDate } from "shared/dates";
import type { ApiKey } from "~/types";

interface ApiKeyManagerProps {
	/** Pre-selected mailbox scope for newly created keys. */
	mailboxId?: string;
}

type KeyStatus = { label: string; variant: "success" | "destructive" | "secondary" };

function keyStatus(key: ApiKey): KeyStatus {
	if (key.revokedAt) return { label: "Revoked", variant: "destructive" };
	if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) {
		return { label: "Expired", variant: "secondary" };
	}
	return { label: "Active", variant: "success" };
}

function scopeLabel(key: ApiKey): string {
	if (key.mailboxIds.includes("*")) return "All mailboxes";
	return key.mailboxIds.join(", ");
}

export default function ApiKeyManager({ mailboxId }: ApiKeyManagerProps) {
	const { data, isLoading, isError, error, refetch } = useApiKeys();
	const revokeKey = useRevokeApiKey();
	const toastManager = useKumoToastManager();

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null);
	const [copiedEndpoint, setCopiedEndpoint] = useState(false);

	const keys = data?.keys ?? [];
	const availableCapabilities = data?.availableCapabilities ?? [];
	const endpoint =
		typeof window !== "undefined" ? `${window.location.origin}/api/ext/v1` : "/api/ext/v1";

	const handleCopyEndpoint = async () => {
		try {
			await navigator.clipboard.writeText(endpoint);
			setCopiedEndpoint(true);
			setTimeout(() => setCopiedEndpoint(false), 2000);
		} catch {
			// Clipboard unavailable — the value is still selectable.
		}
	};

	const handleRevoke = async () => {
		if (!pendingRevoke) return;
		try {
			await revokeKey.mutateAsync(pendingRevoke.id);
			toastManager.add({ title: `Revoked "${pendingRevoke.name}"` });
			setPendingRevoke(null);
		} catch (e) {
			toastManager.add({
				title: e instanceof Error ? e.message : "Failed to revoke API key",
				variant: "error",
			});
		}
	};

	return (
		<section className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="mb-4 flex items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-2">
						<KeyIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">API keys</span>
					</div>
					<p className="mt-1 text-xs text-kumo-subtle">
						Let external applications send newsletter campaigns without a
						browser session.
					</p>
				</div>
				<Button
					variant="primary"
					size="sm"
					icon={<PlusIcon size={14} weight="bold" />}
					onClick={() => setIsCreateOpen(true)}
				>
					Create key
				</Button>
			</div>

			{/* Error state — a failed fetch must be distinguishable from loading. */}
			{isError && (
				<div className="flex items-start gap-2 rounded-lg border border-kumo-error/30 bg-kumo-error/10 px-3 py-2.5">
					<WarningIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-kumo-error" />
					<div className="min-w-0 flex-1">
						<p className="text-xs font-medium text-kumo-strong">
							Could not load API keys.
						</p>
						<p className="mt-0.5 break-words text-[11px] text-kumo-subtle">
							{error instanceof Error ? error.message : "Unknown error"}
						</p>
					</div>
					<Button variant="secondary" size="xs" onClick={() => refetch()}>
						Retry
					</Button>
				</div>
			)}

			{isLoading && (
				<div className="space-y-2">
					{[0, 1].map((row) => (
						<div
							key={row}
							className="h-10 animate-pulse rounded-lg bg-kumo-tint"
							aria-hidden="true"
						/>
					))}
				</div>
			)}

			{!isLoading && !isError && keys.length === 0 && (
				<p className="rounded-lg border border-dashed border-kumo-line px-3 py-6 text-center text-xs text-kumo-subtle">
					No API keys yet. Create one to let an external service post campaigns.
				</p>
			)}

			{!isLoading && !isError && keys.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full border-collapse text-xs">
						<thead>
							<tr className="border-b border-kumo-line text-left text-kumo-subtle">
								<th className="py-2 pr-3 font-medium">Name</th>
								<th className="py-2 pr-3 font-medium">Key</th>
								<th className="py-2 pr-3 font-medium">Mailboxes</th>
								<th className="py-2 pr-3 font-medium">Capabilities</th>
								<th className="py-2 pr-3 font-medium">Created</th>
								<th className="py-2 pr-3 font-medium">Last used</th>
								<th className="py-2 pr-3 font-medium">Status</th>
								<th className="py-2 font-medium"></th>
							</tr>
						</thead>
						<tbody>
							{keys.map((key) => {
								const status = keyStatus(key);
								const canRevoke = !key.revokedAt;
								return (
									<tr key={key.id} className="border-b border-kumo-line/60">
										<td className="py-2 pr-3 align-top text-kumo-default">
											{key.name}
										</td>
										<td className="py-2 pr-3 align-top font-mono text-kumo-subtle">
											{key.prefix}…
										</td>
										<td className="py-2 pr-3 align-top text-kumo-subtle">
											{scopeLabel(key)}
										</td>
										<td className="py-2 pr-3 align-top">
											<div className="flex flex-wrap gap-1">
												{key.capabilities.map((capability) => (
													<Badge key={capability} variant="outline">
														{capability}
													</Badge>
												))}
											</div>
										</td>
										<td className="py-2 pr-3 align-top text-kumo-subtle">
											{formatDetailDate(key.createdAt)}
										</td>
										<td className="py-2 pr-3 align-top text-kumo-subtle">
											{key.lastUsedAt ? formatDetailDate(key.lastUsedAt) : "Never"}
										</td>
										<td className="py-2 pr-3 align-top">
											<Badge variant={status.variant}>{status.label}</Badge>
										</td>
										<td className="py-2 align-top text-right">
											{canRevoke && (
												<Button
													variant="ghost"
													size="xs"
													onClick={() => setPendingRevoke(key)}
												>
													Revoke
												</Button>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{/* Endpoint hint for the integrating service */}
			<div className="mt-4 space-y-1.5">
				<span className="text-xs font-medium text-kumo-strong">Endpoint</span>
				<div className="flex items-center gap-1.5">
					<code className="min-w-0 flex-1 break-all rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 font-mono text-[11px] text-kumo-default">
						{endpoint}
					</code>
					<Tooltip content={copiedEndpoint ? "Copied!" : "Copy"} asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={
								copiedEndpoint ? (
									<CheckIcon size={12} weight="bold" className="text-kumo-success" />
								) : (
									<CopyIcon size={12} />
								)
							}
							onClick={handleCopyEndpoint}
							aria-label="Copy endpoint"
						/>
					</Tooltip>
				</div>
				<p className="text-[11px] leading-relaxed text-kumo-subtle">
					Send <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> with
					each request. Try{" "}
					<code className="font-mono">GET {endpoint}/whoami</code> to verify a key.
				</p>
			</div>

			<ApiKeyCreateDialog
				open={isCreateOpen}
				onOpenChange={setIsCreateOpen}
				defaultMailboxId={mailboxId}
				availableCapabilities={availableCapabilities}
			/>

			{/* Revoke confirmation — deliberately a Dialog, not window.confirm */}
			<Dialog.Root
				open={pendingRevoke !== null}
				onOpenChange={(open) => {
					if (!open && !revokeKey.isPending) setPendingRevoke(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="mb-3 text-base font-semibold">
						Revoke API key?
					</Dialog.Title>
					<p className="text-xs leading-relaxed text-kumo-subtle">
						&ldquo;{pendingRevoke?.name}&rdquo; ({pendingRevoke?.prefix}…) will stop
						working immediately. Applications using it will receive{" "}
						<code className="font-mono">401</code>. This cannot be undone.
					</p>
					<div className="mt-5 flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							loading={revokeKey.isPending}
							onClick={handleRevoke}
						>
							Revoke
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</section>
	);
}
