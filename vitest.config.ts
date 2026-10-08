// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { defineConfig } from "vitest/config";

/**
 * Dedicated Vitest config.
 *
 * It must NOT inherit `vite.config.ts`: the Cloudflare Vite plugin rejects the
 * Node built-in externals that Vitest sets up for the SSR environment, which
 * makes the test runner fail at startup.
 *
 * Tests target runtime-agnostic logic (crypto helpers, scope checks, template
 * rendering), so the plain Node environment is enough.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["workers/**/*.test.ts", "shared/**/*.test.ts"],
	},
});
