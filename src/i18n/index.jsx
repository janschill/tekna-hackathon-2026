import { createContext, useContext, useState, useEffect, useCallback } from "react";
import no from "./no";
import en from "./en";

const translations = { no, en };
const I18nContext = createContext();

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(
    () => localStorage.getItem("wunderbaum-lang") || "no"
  );

  const setLang = useCallback((l) => {
    setLangState(l);
    localStorage.setItem("wunderbaum-lang", l);
    document.documentElement.lang = l;
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, []);

  const t = useCallback(
    (key, vars) => {
      let str = translations[lang]?.[key] ?? translations.no?.[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(new RegExp(`\\{${k}\\}`, "g"), v);
        }
      }
      return str;
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
