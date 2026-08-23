import { createRoot } from "react-dom/client";
import { StrictMode } from "react";

import { App } from "./App";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
