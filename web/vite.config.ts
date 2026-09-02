import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // For parallel development sessions, a launcher can assign PORT (it picks a
    // different port when 5173 is in use). This keeps the default when PORT is unset.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      // UTOPIA_DEV_API can override the backend port. The default, 1516, matches
      // UTOPIA_BIND_ADDR in .env.
      "/api": process.env.UTOPIA_DEV_API ?? "http://127.0.0.1:1516",
    },
  },
});
