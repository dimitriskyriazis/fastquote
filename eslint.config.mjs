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
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
];

export default eslintConfig;
