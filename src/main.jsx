import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "./i18n";
import NordmarkaForest from "./NordmarkaForest";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <I18nProvider>
      <NordmarkaForest />
    </I18nProvider>
  </React.StrictMode>
);
