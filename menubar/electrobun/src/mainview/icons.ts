const GLYPHS: Record<string, string> = {
  home: `<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/>`,
  chart: `<path d="M4 19h16v2H4zM6 10h3v7H6zm5-6h3v13h-3zm5 4h3v9h-3z"/>`,
  toll: `<path d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2zm0 3.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM9.2 18.2 8 16.6l6.2-3.4 1.2 1.6z"/>`,
  description: `<path d="M6 3h8l4 4v14H6zm8 1.5V8h3.5zM8.5 12h7v1.5h-7zm0 3h7v1.5h-7z"/>`,
  forum: `<path d="M4 4h16v12H8l-4 4z"/>`,
  database: `<path d="M12 3c5 0 8 1.3 8 3s-3 3-8 3-8-1.3-8-3 3-3 8-3zm8 5.2v3.6c0 1.7-3 3.2-8 3.2s-8-1.5-8-3.2V8.2c1.6 1.2 4.6 1.8 8 1.8s6.4-.6 8-1.8zm0 5.2v3.6c0 1.7-3 3.2-8 3.2s-8-1.5-8-3.2v-3.6c1.6 1.2 4.6 1.8 8 1.8s6.4-.6 8-1.8z"/>`,
  hub: `<path d="M12 8a2.2 2.2 0 1 0 .001-4.401A2.2 2.2 0 0 0 12 8zm-6.5 10.2a2.2 2.2 0 1 0 .001-4.401 2.2 2.2 0 0 0-.001 4.401zm13 0a2.2 2.2 0 1 0 .001-4.401 2.2 2.2 0 0 0-.001 4.401zM12 9.2 6.8 13.4l1 1.4L12 11.2l4.2 3.6 1-1.4z"/>`,
  settings: `<path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6zM4 10.2h2.1a6.4 6.4 0 0 1 1-2.4L5.6 6.3 7.3 4.6 8.8 6.1a6.4 6.4 0 0 1 2.4-1V3h2.6v2.1a6.4 6.4 0 0 1 2.4 1l1.5-1.5 1.7 1.7-1.5 1.5a6.4 6.4 0 0 1 1 2.4H21v2.6h-2.1a6.4 6.4 0 0 1-1 2.4l1.5 1.5-1.7 1.7-1.5-1.5a6.4 6.4 0 0 1-2.4 1V21h-2.6v-2.1a6.4 6.4 0 0 1-2.4-1l-1.5 1.5-1.7-1.7 1.5-1.5a6.4 6.4 0 0 1-1-2.4H4z"/>`,
  more: `<path d="M6 10.5h2.5V13H6zm4.75 0H13.3V13h-2.55zm4.75 0H18V13h-2.5z"/>`,
  expand: `<path d="M7 9.5 12 14.5 17 9.5z"/>`,
  chevron: `<path d="M9 6.5 14.5 12 9 17.5z"/>`,
  search: `<path d="M10.5 4a6.5 6.5 0 1 0 4.1 11.5l3.7 3.7 1.4-1.4-3.7-3.7A6.5 6.5 0 0 0 10.5 4zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/>`,
  language: `<path d="M12 3a9 9 0 1 0 .001 18.001A9 9 0 0 0 12 3zm6.7 8h-3.1a14 14 0 0 0-1.2-5.1A7 7 0 0 1 18.7 11zM12 5c.7 1.1 1.5 3.1 1.7 6h-3.4C10.5 8.1 11.3 6.1 12 5zM5.3 13h3.1a14 14 0 0 0 1.2 5.1A7 7 0 0 1 5.3 13zm3.1-2H5.3a7 7 0 0 1 4.3-5.1A14 14 0 0 0 8.4 11zM12 19c-.7-1.1-1.5-3.1-1.7-6h3.4c-.2 2.9-1 4.9-1.7 6zm2.3-.9A14 14 0 0 0 15.6 13h3.1a7 7 0 0 1-4.4 5.1z"/>`,
  refresh: `<path d="M12 5a7 7 0 0 1 6.3 4H16v2h6V5h-2v2.2A9 9 0 1 0 21 12h-2a7 7 0 1 1-7-7z"/>`,
  hide: `<path d="M3.3 4.7 2 6l3.1 3.1A9.6 9.6 0 0 0 2 12c1.6 3.2 4.8 6 10 6 1.7 0 3.2-.4 4.6-1.1L20 20.2l1.3-1.3zM12 16c-3.4 0-6-1.9-7.5-4 .6-.9 1.5-1.8 2.6-2.4l1.6 1.6a3 3 0 0 0 4.1 4.1l1.5 1.5c-.7.1-1.5.2-2.3.2zm9.4-2.6-1.5-1.5c.3-.5.6-1 .8-1.5A8.6 8.6 0 0 0 15 7.2l-1.5 1.5A3 3 0 0 1 9.7 14L8 15.7c1.1.5 2.4.8 4 .8 3.4 0 6-1.9 7.4-4.1z"/>`,
  share: `<path d="M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14zM6 6h6v2H8v10h10v-4h2v6H6z"/>`,
  layout: `<path d="M4 4h7v7H4zm9 0h7v4h-7zM4 13h7v7H4zm9-3h7v10h-7z"/>`,
  open: `<path d="M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14zM6 6h5v2H8v10h10v-3h2v5H6z"/>`,
  pie: `<path d="M12 3a9 9 0 1 0 9 9h-9zm2 0.2V10h6.8A9 9 0 0 0 14 3.2z"/>`,
  analytics: `<path d="M4 19h16v2H4zm2-8h3v6H6zm5-5h3v11h-3zm5 3h3v8h-3z"/>`,
  repeat: `<path d="M7 7h8.2l-1.6-1.6L15 4l4 4-4 4-1.4-1.4L15.2 9H7a3 3 0 0 0-3 3v1H2v-1a5 5 0 0 1 5-5zm10 10H8.8l1.6 1.6L9 20l-4-4 4-4 1.4 1.4L8.8 15H17a3 3 0 0 0 3-3v-1h2v1a5 5 0 0 1-5 5z"/>`,
  check: `<path d="M7 4h10a2 2 0 0 1 2 2v14l-3-2-2 2-2-2-2 2-2-2-3 2V6a2 2 0 0 1 2-2zm2.2 8.8 1.6 1.6 3.8-3.8 1.2 1.2-5 5-2.8-2.8z"/>`,
  card: `<path d="M3 6h18v12H3zm2 4v2h14v-2z"/>`,
  wallet: `<path d="M3 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3zm12 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>`,
};

export function glyph(name: string): string {
  const path = GLYPHS[name] ?? "";
  return `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

const TAB_GLYPHS: Record<string, string> = {
  overview: "home",
  quotas: "chart",
  tokens: "toll",
  reports: "description",
  sessions: "forum",
  sources: "database",
  mcp: "hub",
  settings: "settings",
};

export function tabGlyph(tabId: string): string {
  return glyph(TAB_GLYPHS[tabId] ?? "more");
}
