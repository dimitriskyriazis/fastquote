export const openLinkInNewTab = (href: string) => {
  if (typeof window === "undefined") {
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
};
