import nextCoreWebVitalsModule from "eslint-config-next/core-web-vitals";
import nextTypescriptModule from "eslint-config-next/typescript";

const nextCoreWebVitals = nextCoreWebVitalsModule.default ?? nextCoreWebVitalsModule;
const nextTypescript = nextTypescriptModule.default ?? nextTypescriptModule;

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
