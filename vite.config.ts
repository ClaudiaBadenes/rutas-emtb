import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// La app es 100 % estática. En desarrollo, /brouter apunta al servidor BRouter local (npm run brouter);
// en producción se usa brouter.de (ver .env.production).
// En GitHub Pages la app vive en una subcarpeta (https://<usuario>.github.io/rutas-emtb/): VITE_BASE=/rutas-emtb/
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // accesible desde el móvil en la misma wifi
    proxy: { "/brouter": "http://localhost:17777" },
  },
  preview: { port: 4173, host: true, proxy: { "/brouter": "http://localhost:17777" } },
});
