import type { Plugin } from "vite";

const iconVariantPaths = {
  local: "/assets/app-icons/local",
  preview: "/assets/app-icons/preview",
} as const;

type IconVariant = keyof typeof iconVariantPaths;

function getIconVariant(env: Record<string, string>): IconVariant | undefined {
  if (env.VERCEL_ENV === "preview") {
    return "preview";
  }

  if (env.VERCEL_ENV === "production") {
    return undefined;
  }

  return "local";
}

function appIconVariantPlugin(variant: IconVariant | undefined): Plugin {
  return {
    name: "voidmesh-app-icon-variant",
    transformIndexHtml(html) {
      if (!variant) {
        return html;
      }

      const path = iconVariantPaths[variant];
      const iconLinks = [
        `<link rel="icon" type="image/png" sizes="16x16" href="${path}/favicon-16x16.png" />`,
        `<link rel="icon" type="image/png" sizes="32x32" href="${path}/favicon-32x32.png" />`,
        `<link rel="icon" type="image/png" sizes="64x64" href="${path}/favicon-64x64.png" />`,
        `<link rel="icon" type="image/webp" sizes="512x512" href="${path}/favicon.webp" />`,
        `<link rel="apple-touch-icon" sizes="180x180" href="${path}/apple-touch-icon.png" />`,
      ].join("\n    ");

      return html.replace(
        `    <link rel="icon" href="/favicon.ico" sizes="32x32" />\n    <link rel="icon" type="image/png" sizes="512x512" href="/favicon.webp" />\n    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
        `    ${iconLinks}`,
      );
    },
  };
}

export const EnvAwareIcon = {
  getIconVariant,
  appIconVariantPlugin,
};
