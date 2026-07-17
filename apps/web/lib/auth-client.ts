import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/v1/auth",
  baseURL: location.origin,
  fetchOptions: { credentials: "include", timeout: 10_000 },
});
