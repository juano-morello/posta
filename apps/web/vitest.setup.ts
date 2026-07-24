// E6 test tooling — shared Vitest setup for apps/web's component tests
// (the 'web' project in the root vitest.config.ts). Registers jest-dom's
// matchers (toBeInTheDocument, toHaveAttribute, etc.) and an explicit
// afterEach(cleanup): Testing Library's own auto-cleanup only self-registers
// when it finds `afterEach` on globalThis, which requires Vitest's
// `test.globals: true` — the root config deliberately does not set that
// (every other package imports test/expect explicitly), so this file wires
// cleanup manually instead of flipping a repo-wide flag for one project.
import '@testing-library/jest-dom/vitest';

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
