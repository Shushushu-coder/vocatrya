import rootConfig from "../../eslint.config.mjs";
export default [...rootConfig, { ignores: ["dist/**"] }, { rules: { "@next/next/no-html-link-for-pages": "off" } }];
