import type { AppRouter } from "@submerge/server/router";
import { createTRPCContext } from "@trpc/tanstack-react-query";

// The single client-side source for router query/mutation types (serialized outputs).
export type { RouterOutputs } from "@submerge/server/router";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
