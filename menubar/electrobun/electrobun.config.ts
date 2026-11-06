import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "tokitoki",
    identifier: "dev.tokitoki.menubar",
    version: "0.4.0",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      "src/mainview/tray.png": "views/mainview/tray.png",
      "src/mainview/tray.ico": "views/mainview/tray.ico",
    },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
