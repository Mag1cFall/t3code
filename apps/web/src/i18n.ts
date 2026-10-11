import i18next from "i18next";

import zhHant from "./locales/zh-Hant.json";

// 测试环境保留英文原文，界面默认显示正体中文
void i18next.init({
  lng: import.meta.env.MODE === "test" ? "en" : "zh-Hant",
  resources: { "zh-Hant": { translation: zhHant } },
  fallbackLng: false,
  keySeparator: false,
  nsSeparator: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
  initAsync: false,
});

// tr 以英文原文为键查找正体中文，缺少译文时返回原文
export function tr(key: string, values?: Record<string, unknown>): string {
  return values === undefined ? i18next.t(key) : i18next.t(key, values);
}
