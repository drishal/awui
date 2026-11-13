import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { installRipple } from "./ripple.js";
import { mountGuestOrApp } from "./guest-view.js";
import "./styles.css";

installRipple();

const root = document.getElementById("root");
if (root) {
  // A guest link (/guest/:token) renders its own standalone view, outside the app shell.
  mountGuestOrApp();
}
