// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { ApiKey, ApiKeyCapability, CreatedApiKey } from "~/types";
import { queryKeys } from "./keys";

export interface ApiKeyListResponse {
	keys: ApiKey[];
	availableCapabilities: ApiKeyCapability[];
}

export interface CreateApiKeyInput {
	name: string;
	mailboxIds: string[];
	capabilities: string[];
	expiresAt?: string | null;
}

export function useApiKeys() {
	return useQuery<ApiKeyListResponse>({
		queryKey: queryKeys.newsletter.apiKeys(),
		queryFn: () => api.listApiKeys(),
	});
}

export function useCreateApiKey() {
	const qc = useQueryClient();
	return useMutation<CreatedApiKey, Error, CreateApiKeyInput>({
		mutationFn: (input) => api.createApiKey(input),
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: queryKeys.newsletter.apiKeys() }),
	});
}

export function useRevokeApiKey() {
	const qc = useQueryClient();
	return useMutation<void, Error, string>({
		mutationFn: (id) => api.revokeApiKey(id),
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: queryKeys.newsletter.apiKeys() }),
	});
}
