import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

function spaFallback(): Plugin {
  return {
    name: "pool-proxy-spa-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || "/";
        const accept = req.headers.accept || "";
        if (
          req.method === "GET" &&
          accept.includes("text/html") &&
          !url.startsWith("/api/") &&
          !url.startsWith("/v1") &&
          !url.startsWith("/ws") &&
          !url.startsWith("/@") &&
          !url.includes(".")
        ) {
          req.url = "/";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [spaFallback(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) return "vendor-react";
          if (id.includes("/react-router-dom/") || id.includes("/@remix-run/")) return "vendor-router";
          if (id.includes("/@radix-ui/")) return "vendor-radix";
          if (id.includes("/recharts/") || id.includes("/d3-")) return "vendor-charts";
          if (id.includes("/lucide-react/")) return "vendor-icons";
          return "vendor";
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.DASHBOARD_PORT) || 1731,
  },
});
