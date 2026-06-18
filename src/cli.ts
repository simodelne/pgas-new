import {
  PGAS_SERVER_IMPORTS,
  PGAS_SERVER_PACKAGE,
  PGAS_SERVER_VERSION,
} from "./pgas-new/version.js";

const output = [
  "pgas-new tooling foundation",
  `PGAS server: ${PGAS_SERVER_PACKAGE}@${PGAS_SERVER_VERSION}`,
  "Allowed imports:",
  ...PGAS_SERVER_IMPORTS.map((specifier) => `- ${specifier}`),
];

console.log(output.join("\n"));
