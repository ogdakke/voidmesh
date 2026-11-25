/**
 * Builds that may expose developer tooling (debug mode toggle): local dev and Vercel preview
 * deployments. Production builds never do.
 */
export const isPreviewBuild: boolean =
  import.meta.env.DEV || import.meta.env.VITE_VERCEL_ENV === "preview";
