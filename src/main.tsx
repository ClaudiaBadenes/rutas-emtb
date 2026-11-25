import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);

// Service worker (solo en la versión compilada: en desarrollo molestaría con la caché)
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
